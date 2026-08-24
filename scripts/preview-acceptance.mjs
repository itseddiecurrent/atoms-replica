import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BROWSER_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ],
  linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function canonicalPreviewUrl(value) {
  return new URL(value).href;
}

export function resolveBrowserExecutable(env = process.env, platform = process.platform) {
  if (env.E2E_BROWSER_EXECUTABLE_PATH) {
    if (!existsSync(env.E2E_BROWSER_EXECUTABLE_PATH)) {
      throw new Error("E2E_BROWSER_EXECUTABLE_PATH does not point to an installed browser.");
    }
    return env.E2E_BROWSER_EXECUTABLE_PATH;
  }
  const discovered = (DEFAULT_BROWSER_PATHS[platform] ?? []).find((path) => existsSync(path));
  if (!discovered) {
    throw new Error(
      "No Chromium browser was found. Set E2E_BROWSER_EXECUTABLE_PATH to Chrome or Chromium."
    );
  }
  return discovered;
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Chromium DevTools connection timed out.")),
        10_000
      );
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Unable to connect to Chromium DevTools."));
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      const key = `${message.sessionId ?? "browser"}:${message.method}`;
      for (const listener of this.listeners.get(key) ?? []) listener(message.params ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chromium DevTools connection closed."));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium command ${method} timed out.`));
      }, 30_000);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, listener, sessionId) {
    const key = `${sessionId ?? "browser"}:${method}`;
    const current = this.listeners.get(key) ?? [];
    current.push(listener);
    this.listeners.set(key, current);
    return () =>
      this.listeners.set(
        key,
        (this.listeners.get(key) ?? []).filter((item) => item !== listener)
      );
  }

  close() {
    this.socket.close();
  }
}

async function launchBrowserOnce({
  executablePath = resolveBrowserExecutable(),
  timeoutMs = 20_000
} = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), "atom-preview-browser-"));
  const child = spawn(
    executablePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  const webSocketUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Chromium did not expose a DevTools endpoint in time."));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Chromium exited before startup (${code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`}).`
        )
      );
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  }).catch((error) => {
    rmSync(profileDir, { recursive: true, force: true });
    throw error;
  });
  const connection = new CdpConnection(webSocketUrl);
  try {
    await connection.ready;
  } catch (error) {
    connection.close();
    child.kill("SIGTERM");
    rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
  return {
    connection,
    async close() {
      connection.close();
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(2_000).then(() => child.kill("SIGKILL"))
      ]);
      rmSync(profileDir, { recursive: true, force: true });
    }
  };
}

export async function launchBrowser({ startupAttempts = 2, retryDelayMs = 500, ...options } = {}) {
  assert.ok(
    Number.isInteger(startupAttempts) && startupAttempts > 0,
    "Chromium startup attempts must be a positive integer."
  );
  let lastError;
  for (let attempt = 1; attempt <= startupAttempts; attempt += 1) {
    try {
      return await launchBrowserOnce(options);
    } catch (error) {
      lastError = error;
      if (attempt < startupAttempts) await sleep(retryDelayMs);
    }
  }
  throw new Error(
    `Chromium failed to start after ${startupAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError }
  );
}

export async function createPage(connection) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true
  });
  await Promise.all([
    connection.send("Page.enable", {}, sessionId),
    connection.send("Runtime.enable", {}, sessionId),
    connection.send("Network.enable", {}, sessionId),
    connection.send("Log.enable", {}, sessionId)
  ]);
  return {
    targetId,
    sessionId,
    async evaluate(expression) {
      const result = await connection.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? "Browser evaluation failed."
        );
      }
      return result.result?.value;
    },
    async navigate(url) {
      const result = await connection.send("Page.navigate", { url }, sessionId);
      if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
      await waitUntil(() => this.evaluate("document.readyState === 'complete'"), {
        timeoutMs: 30_000,
        message: `Browser did not finish loading ${new URL(url).origin}.`
      });
    },
    async close() {
      await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  };
}

export async function waitUntil(
  check,
  { timeoutMs = 15_000, intervalMs = 150, message = "Condition timed out." } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(lastError ? `${message} ${lastError.message}` : message);
}

async function workspacePreviewLoaded(page, previewUrl) {
  const expectedHref = canonicalPreviewUrl(previewUrl);
  const state = await page.evaluate(`(() => {
    const frame = document.querySelector("iframe");
    const expectedHref = ${JSON.stringify(expectedHref)};
    const observedHref = frame ? new URL(frame.src).href : undefined;
    const iframeLoads = window.__atomAcceptance?.iframeLoads ?? [];
    return {
      framePresent: Boolean(frame),
      urlMatches: observedHref === expectedHref,
      loadObserved: iframeLoads.some((url) => new URL(url).href === expectedHref),
      observedOrigin: observedHref ? new URL(observedHref).origin : undefined,
      loadCount: iframeLoads.length
    };
  })()`);
  if (!state.framePresent) throw new Error("No Preview iframe is present in the workspace.");
  if (!state.urlMatches) {
    throw new Error(
      `Workspace iframe points to ${state.observedOrigin ?? "an unknown origin"}, not the generated Preview origin.`
    );
  }
  if (!state.loadObserved) {
    throw new Error(
      `Preview iframe URL matched, but no load event was observed (${state.loadCount}).`
    );
  }
  return true;
}

const workspaceProbeScript = String.raw`(() => {
  if (window.top !== window) return;
  window.__atomAcceptance = { fetches: [], iframeLoads: [] };
  const track = (frame) => {
    if (frame.dataset.atomAcceptanceTracked) return;
    frame.dataset.atomAcceptanceTracked = "true";
    frame.addEventListener("load", () => window.__atomAcceptance.iframeLoads.push(frame.src));
  };
  new MutationObserver((changes) => {
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement) track(node);
        node.querySelectorAll?.("iframe").forEach(track);
      }
    }
  }).observe(document, { childList: true, subtree: true });
})()`;

const fetchProbeScript = String.raw`(() => {
  const original = window.fetch.bind(window);
  window.__atomAcceptance.fetches = [];
  window.fetch = async (...args) => {
    const request = args[0];
    const options = args[1] || {};
    const url = typeof request === "string" ? request : request.url;
    const method = String(options.method || (typeof request === "string" ? "GET" : request.method) || "GET").toUpperCase();
    const response = await original(...args);
    if (/\/api\/(projects\/[^/]+\/runtime\/restart|runtime-jobs\/)/.test(url)) {
      let body;
      try { body = await response.clone().json(); } catch {}
      window.__atomAcceptance.fetches.push({
        path: new URL(url, location.href).pathname,
        method,
        status: response.status,
        body: body ? {
          runtimeJobId: body.runtimeJobId,
          status: body.status,
          operation: body.resultJson?.operation,
          previewUrl: body.resultJson?.previewUrl,
          error: body.error,
          errorMessage: body.errorMessage
        } : undefined
      });
    }
    return response;
  };
})()`;

const todoInteractionScript = String.raw`(async () => {
  const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const text = (element) => (element.innerText || element.textContent || "").trim();
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const input = all('input:not([type]), input[type="text"], input[type="search"], textarea')
    .find((element) => !element.disabled && !element.readOnly);
  if (!input) throw new Error("Todo Preview has no visible text input.");
  const form = input.closest("form");
  const buttons = () => all("button, [role=button], input[type=submit]");
  const addButton = () => {
    const scoped = form ? [...form.querySelectorAll("button, [role=button], input[type=submit]")].filter(visible) : [];
    return [...scoped, ...buttons()].find((element) => /^(add|create|new|添加|新增|创建)(\s|$)/i.test(text(element) || element.getAttribute("aria-label") || element.title || element.value || ""));
  };
  const setInput = (value) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const submit = async () => {
    await pause();
    const button = addButton();
    if (button) button.click();
    else if (form?.requestSubmit) form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await pause(250);
  };
  const hasText = (value) => document.body.innerText.includes(value);
  const waitFor = async (check, message) => {
    for (let index = 0; index < 50; index += 1) {
      const value = check();
      if (value) return value;
      await pause();
    }
    throw new Error(message);
  };
  const remainingLine = (expected) => {
    const label = "remaining|left|incomplete|active|pending|outstanding|open|to do|todo|未完成|剩余|还剩|还有|待完成|待办";
    const lines = document.body.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const accessible = all("[aria-label], [title]").flatMap((element) =>
      [element.getAttribute("aria-label"), element.title].filter(Boolean)
    );
    const direct = [...lines, ...accessible].find((line) => new RegExp("(^|\\D)" + expected + "(\\D|$)").test(line) && new RegExp(label, "i").test(line));
    if (direct) return direct;
    const normalized = document.body.innerText.replace(/\s+/g, " ");
    return normalized.match(new RegExp("(?:" + label + ")[^0-9]{0,30}" + expected + "(?:\\D|$)|(?:^|\\D)" + expected + "[^0-9]{0,30}(?:" + label + ")", "i"))?.[0];
  };
  const itemContainer = (value) => {
    const leaf = all("body *").find((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() === value));
    if (!leaf) return undefined;
    return leaf.closest('li, [role="listitem"], article') || [leaf, leaf.parentElement, leaf.parentElement?.parentElement, leaf.parentElement?.parentElement?.parentElement]
      .find((element) => element && element.querySelector('input[type="checkbox"], button, [role="checkbox"], [role="button"]')) || leaf.parentElement;
  };
  const toggle = async (value) => {
    const container = itemContainer(value);
    if (!container) throw new Error("Todo item " + value + " was not rendered.");
    const controls = [...container.querySelectorAll('input[type="checkbox"], [role="checkbox"], button, [role="button"]')].filter(visible);
    const control = controls.find((element) => {
      if (!visible(element)) return false;
      if (element.matches('input[type="checkbox"], [role="checkbox"]')) return true;
      return /(complete|done|toggle|check|完成|勾选)/i.test(text(element) || element.getAttribute("aria-label") || element.title || "");
    }) || (controls.length > 1 ? controls[0] : undefined);
    if (!control) throw new Error("Todo item " + value + " has no completion control.");
    control.click();
    await pause(250);
  };
  const remove = async (value) => {
    const container = itemContainer(value);
    if (!container) throw new Error("Todo item " + value + " was not rendered.");
    const controls = [...container.querySelectorAll('button, [role="button"]')].filter(visible);
    const control = controls.find((element) => /(delete|remove|trash|删除|移除)/i.test(text(element) || element.getAttribute("aria-label") || element.title || "")) || (controls.length > 1 || container.querySelector('input[type="checkbox"], [role="checkbox"]') ? controls.at(-1) : undefined);
    if (!control) throw new Error("Todo item " + value + " has no delete control.");
    control.click();
    await pause(250);
  };
  const clearExistingTodos = async () => {
    for (let index = 0; index < 50; index += 1) {
      const labeled = buttons().find((element) =>
        /(delete|remove|trash|删除|移除)/i.test(text(element) || element.getAttribute("aria-label") || element.title || "")
      );
      const container = all('li, [role="listitem"]').find((element) =>
        element.querySelector('button, [role="button"]')
      );
      const controls = container
        ? [...container.querySelectorAll('button, [role="button"]')].filter(visible)
        : [];
      const fallback = controls.length > 1 ? controls.at(-1) : undefined;
      const control = labeled || fallback;
      if (!control) return;
      control.click();
      await pause(250);
    }
    throw new Error("Todo Preview seed items could not be cleared.");
  };

  const first = "Preview acceptance alpha";
  const second = "Preview acceptance beta";
  await clearExistingTodos();
  setInput("");
  await submit();
  const emptyRejected = Boolean(remainingLine(0)) && !remainingLine(1) && input.value.trim() === "";
  setInput(first);
  await submit();
  await waitFor(() => hasText(first), "First Todo was not added.");
  setInput(second);
  await submit();
  await waitFor(() => hasText(second), "Second Todo was not added.");
  const countAfterAdd = await waitFor(() => remainingLine(2), "Remaining count did not reach two after adding Todos.");
  await toggle(first);
  const countAfterComplete = await waitFor(() => remainingLine(1), "Remaining count did not decrease after completion.");
  await toggle(first);
  const countAfterRestore = await waitFor(() => remainingLine(2), "Remaining count did not increase after restoring.");
  await remove(second);
  await waitFor(() => !hasText(second), "Deleted Todo remained visible.");
  const countAfterDelete = remainingLine(1);
  return {
    emptyRejected,
    firstAdded: hasText(first),
    secondDeleted: !hasText(second),
    countAfterAdd: Boolean(countAfterAdd),
    countAfterComplete: Boolean(countAfterComplete),
    countAfterRestore: Boolean(countAfterRestore),
    countAfterDelete: Boolean(countAfterDelete)
  };
})()`;

export const incrementalInteractionScript = String.raw`(async () => {
  const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const text = (element) => (element.innerText || element.textContent || "").trim();
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const waitFor = async (check, message) => {
    for (let index = 0; index < 60; index += 1) {
      const value = check();
      if (value) return value;
      await pause();
    }
    throw new Error(message);
  };
  const input = all('input:not([type]), input[type="text"], input[type="search"], textarea')
    .find((element) => !element.disabled && !element.readOnly);
  if (!input) throw new Error("Incremental Todo Preview has no visible text input.");
  const form = input.closest("form");
  const buttons = () => all('button, [role="button"], input[type="submit"]');
  const namedButton = (name) => buttons().find((element) =>
    new RegExp("^" + name + "$", "i").test(text(element) || element.getAttribute("aria-label") || element.title || element.value || "")
  );
  const addButton = () => {
    const scoped = form ? [...form.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible) : [];
    return [...scoped, ...buttons()].find((element) => /^(add|create|new|添加|新增|创建)(\s|$)/i.test(text(element) || element.getAttribute("aria-label") || element.title || element.value || ""));
  };
  const setInput = (value) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const submit = async () => {
    await pause();
    const button = addButton();
    if (button) button.click();
    else if (form?.requestSubmit) form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await pause(300);
  };
  const remainingLine = (expected) => {
    const label = "remaining|left|incomplete|active|pending|outstanding|open|to do|todo|未完成|剩余|还剩|还有|待完成|待办";
    const lines = document.body.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const accessible = all("[aria-label], [title]").flatMap((element) =>
      [element.getAttribute("aria-label"), element.title].filter(Boolean)
    );
    return [...lines, ...accessible].find((line) =>
      new RegExp("(^|\\D)" + expected + "(\\D|$)").test(line) && new RegExp(label, "i").test(line)
    );
  };
  const itemContainer = (value, includeHidden = false) => {
    const elements = [...document.querySelectorAll("body *")];
    const leaf = elements.find((element) =>
      (includeHidden || visible(element)) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() === value)
    );
    if (!leaf) return undefined;
    return leaf.closest('li, [role="listitem"], article') || [leaf, leaf.parentElement, leaf.parentElement?.parentElement, leaf.parentElement?.parentElement?.parentElement]
      .find((element) => element && element.querySelector('input[type="checkbox"], button, [role="checkbox"], [role="button"]')) || leaf.parentElement;
  };
  const itemVisible = (value) => {
    const container = itemContainer(value, true);
    return Boolean(container && visible(container));
  };
  const toggle = async (value) => {
    const container = itemContainer(value);
    if (!container) throw new Error("Todo item " + value + " was not rendered.");
    const controls = [...container.querySelectorAll('input[type="checkbox"], [role="checkbox"], button, [role="button"]')].filter(visible);
    const control = controls.find((element) => {
      if (element.matches('input[type="checkbox"], [role="checkbox"]')) return true;
      return /(complete|done|toggle|check|完成|勾选)/i.test(text(element) || element.getAttribute("aria-label") || element.title || "");
    }) || (controls.length > 1 ? controls[0] : undefined);
    if (!control) throw new Error("Todo item " + value + " has no completion control.");
    control.click();
    await pause(300);
  };
  const remove = async (value) => {
    const container = itemContainer(value);
    if (!container) throw new Error("Todo item " + value + " was not rendered.");
    const controls = [...container.querySelectorAll('button, [role="button"]')].filter(visible);
    const control = controls.find((element) => /(delete|remove|trash|删除|移除)/i.test(text(element) || element.getAttribute("aria-label") || element.title || "")) || controls.at(-1);
    if (!control) throw new Error("Todo item " + value + " has no delete control.");
    control.click();
    await pause(300);
  };
  const clearExistingTodos = async () => {
    for (let index = 0; index < 50; index += 1) {
      const labeled = buttons().find((element) => /(delete|remove|trash|删除|移除)/i.test(text(element) || element.getAttribute("aria-label") || element.title || ""));
      const container = all('li, [role="listitem"]').find((element) => element.querySelector('button, [role="button"]'));
      const controls = container ? [...container.querySelectorAll('button, [role="button"]')].filter(visible) : [];
      const fallback = controls.length > 1 ? controls.at(-1) : undefined;
      const control = labeled || fallback;
      if (!control) return;
      control.click();
      await pause(250);
    }
    throw new Error("Todo Preview seed items could not be cleared.");
  };

  const filterAll = namedButton("All");
  const filterActive = namedButton("Active");
  const filterCompleted = namedButton("Completed");
  const titleVisible = document.body.innerText.includes("Focus Todo");
  const filtersVisible = Boolean(filterAll && filterActive && filterCompleted);
  if (!titleVisible || !filtersVisible) throw new Error("Follow-up title or filter controls are missing.");
  filterAll.click();
  await pause();
  await clearExistingTodos();

  const first = "Incremental acceptance alpha";
  const second = "Incremental acceptance beta";
  setInput("");
  await submit();
  const emptyRejected = Boolean(remainingLine(0)) && input.value.trim() === "";
  setInput(first);
  await submit();
  await waitFor(() => itemVisible(first), "First incremental Todo was not added.");
  setInput(second);
  await submit();
  await waitFor(() => itemVisible(second), "Second incremental Todo was not added.");
  const countAfterAdd = await waitFor(() => remainingLine(2), "Remaining count did not reach two.");
  await toggle(first);
  const countAfterComplete = await waitFor(() => remainingLine(1), "Remaining count did not decrease.");

  filterActive.click();
  await pause(300);
  const activeFilterPassed = !itemVisible(first) && itemVisible(second);
  filterCompleted.click();
  await pause(300);
  const completedFilterPassed = itemVisible(first) && !itemVisible(second);
  filterAll.click();
  await pause(300);
  const allFilterPassed = itemVisible(first) && itemVisible(second);

  await toggle(first);
  const countAfterRestore = await waitFor(() => remainingLine(2), "Remaining count did not increase after restore.");
  await remove(second);
  await waitFor(() => !itemVisible(second), "Deleted Todo remained visible.");
  const countAfterDelete = remainingLine(1);
  return {
    titleVisible,
    filtersVisible,
    emptyRejected,
    twoAdded: itemVisible(first) && Boolean(countAfterAdd),
    completePassed: Boolean(countAfterComplete),
    activeFilterPassed,
    completedFilterPassed,
    allFilterPassed,
    restorePassed: Boolean(countAfterRestore),
    deletePassed: !itemVisible(second),
    countSequencePassed: Boolean(countAfterAdd && countAfterComplete && countAfterRestore && countAfterDelete)
  };
})()`;

export function validatePreviewAcceptanceEvidence(evidence) {
  assert.match(evidence.projectId, /^[0-9a-f-]{36}$/i, "Project ID must be recorded.");
  assert.match(evidence.runId, /^[0-9a-f-]{36}$/i, "Run ID must be recorded.");
  assert.match(evidence.previewUrl, /^https:\/\//, "Preview URL must use HTTPS.");
  assert.equal(evidence.previewHttpStatus, 200, "Preview must return HTTP 200.");
  assert.equal(evidence.workspaceHttpStatus, 200, "Authenticated workspace must return HTTP 200.");
  assert.equal(evidence.iframeLoaded, true, "Workspace iframe did not load the Preview.");
  assert.equal(evidence.reloadRestored, true, "Workspace reload did not restore the Preview URL.");
  assert.deepEqual(evidence.interactions, {
    emptyRejected: true,
    firstAdded: true,
    secondDeleted: true,
    countAfterAdd: true,
    countAfterComplete: true,
    countAfterRestore: true,
    countAfterDelete: true
  });
  assert.equal(evidence.restartQueued, true, "Restart was not queued by the workspace UI.");
  assert.equal(evidence.restartCompleted, true, "Worker restart job did not complete.");
  assert.match(
    evidence.restartedPreviewUrl,
    /^https:\/\//,
    "Restart did not return HTTPS Preview."
  );
  assert.equal(evidence.restartedPreviewHttpStatus, 200, "Restarted Preview must return HTTP 200.");
  assert.equal(evidence.browserSecurityErrors, 0, "Browser reported CSP or mixed-content errors.");
  assert.equal(
    evidence.previewMutationRequests,
    0,
    "Todo interactions sent a remote mutation request."
  );
  return { ...evidence, checkedAt: evidence.checkedAt ?? new Date().toISOString() };
}

export function formatPreviewAcceptanceReport(evidence) {
  const accepted = validatePreviewAcceptanceEvidence(evidence);
  return [
    "## Preview Production Acceptance Record",
    "",
    `- Checked at: ${accepted.checkedAt}`,
    `- Project ID: ${accepted.projectId}`,
    `- Run ID: ${accepted.runId}`,
    `- Initial Preview: HTTP ${accepted.previewHttpStatus} (HTTPS)`,
    "- Todo interaction: empty rejected; two added; complete, restore, and delete passed",
    "- Remaining count: 2 → 1 → 2 → 1",
    "- Workspace iframe: loaded and restored after reload",
    `- Restart job: queued by UI and completed by Worker (HTTP ${accepted.restartedPreviewHttpStatus})`,
    "- Browser security errors: 0",
    "- Preview mutation requests: 0 (state remained browser-local)"
  ].join("\n");
}

export async function probePreviewBrowser(executablePath) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  try {
    await page.navigate("data:text/html,<title>Atom Preview Probe</title><main>ready</main>");
    return await page.evaluate(
      "document.title === 'Atom Preview Probe' && document.querySelector('main')?.textContent === 'ready'"
    );
  } finally {
    await page.close().catch(() => undefined);
    await browser.close();
  }
}

export async function runIncrementalPreviewBrowserAcceptance({
  baseUrl,
  projectId,
  previewUrl,
  cookie,
  expectedMessages,
  executablePath
}) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  const securityErrors = [];
  const mutationRequests = [];
  const removeListeners = [
    browser.connection.on(
      "Network.loadingFailed",
      (event) => {
        if (
          ["csp", "mixed-content", "origin"].some((term) =>
            String(event.blockedReason ?? "")
              .toLowerCase()
              .includes(term)
          )
        ) {
          securityErrors.push(event.blockedReason);
        }
      },
      page.sessionId
    ),
    browser.connection.on(
      "Log.entryAdded",
      ({ entry }) => {
        if (
          entry?.level === "error" &&
          /(content security policy|mixed content|refused to frame|blocked by)/i.test(
            entry.text ?? ""
          )
        ) {
          securityErrors.push("browser-security-error");
        }
      },
      page.sessionId
    ),
    browser.connection.on(
      "Network.requestWillBeSent",
      ({ request }) => {
        if (
          new URL(request.url).origin === new URL(previewUrl).origin &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        ) {
          mutationRequests.push(request.method);
        }
      },
      page.sessionId
    )
  ];

  try {
    const [cookieName, ...cookieValue] = cookie.split("=");
    await browser.connection.send(
      "Network.setCookie",
      {
        name: cookieName,
        value: cookieValue.join("="),
        domain: new URL(baseUrl).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax"
      },
      page.sessionId
    );
    await page.navigate(`${baseUrl}/projects/${projectId}`);
    const conversationPersisted = await waitUntil(
      () =>
        page.evaluate(`(() => {
          const expected = ${JSON.stringify(expectedMessages)};
          return expected.every((message) => document.body.innerText.includes(message));
        })()`),
      { timeoutMs: 30_000, message: "Workspace did not restore both user prompts." }
    );
    await page.navigate(previewUrl);
    const interactions = await page.evaluate(incrementalInteractionScript);
    return {
      conversationPersisted: Boolean(conversationPersisted),
      interactions,
      browserSecurityErrors: securityErrors.length,
      previewMutationRequests: mutationRequests.length
    };
  } finally {
    removeListeners.forEach((remove) => remove());
    await page.close().catch(() => undefined);
    await browser.close();
  }
}

export async function runPreviewBrowserAcceptance({
  baseUrl,
  projectId,
  runId,
  previewUrl,
  cookie,
  executablePath,
  restartTimeoutMs = 6 * 60_000
}) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  const securityErrors = [];
  const mutationRequests = [];
  const previewResponses = [];
  const removeListeners = [
    browser.connection.on(
      "Network.loadingFailed",
      (event) => {
        if (
          ["csp", "mixed-content", "origin"].some((term) =>
            String(event.blockedReason ?? "")
              .toLowerCase()
              .includes(term)
          )
        ) {
          securityErrors.push(event.blockedReason);
        }
      },
      page.sessionId
    ),
    browser.connection.on(
      "Log.entryAdded",
      ({ entry }) => {
        if (
          entry?.level === "error" &&
          /(content security policy|mixed content|refused to frame|blocked by)/i.test(
            entry.text ?? ""
          )
        ) {
          securityErrors.push("browser-security-error");
        }
      },
      page.sessionId
    ),
    browser.connection.on(
      "Network.requestWillBeSent",
      ({ request }) => {
        if (
          new URL(request.url).origin === new URL(previewUrl).origin &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        ) {
          mutationRequests.push(request.method);
        }
      },
      page.sessionId
    ),
    browser.connection.on(
      "Network.responseReceived",
      ({ response, type }) => {
        if (type === "Document" && new URL(response.url).origin === new URL(previewUrl).origin) {
          previewResponses.push(response.status);
        }
      },
      page.sessionId
    )
  ];

  try {
    const [cookieName, ...cookieValue] = cookie.split("=");
    await browser.connection.send(
      "Network.setCookie",
      {
        name: cookieName,
        value: cookieValue.join("="),
        domain: new URL(baseUrl).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax"
      },
      page.sessionId
    );
    await browser.connection.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: workspaceProbeScript },
      page.sessionId
    );
    const workspaceUrl = `${baseUrl}/projects/${projectId}`;
    await page.navigate(workspaceUrl);
    const iframeLoaded = await waitUntil(() => workspacePreviewLoaded(page, previewUrl), {
      timeoutMs: 30_000,
      message: "Production workspace iframe did not load."
    });

    await browser.connection.send("Page.reload", { ignoreCache: true }, page.sessionId);
    const reloadRestored = await waitUntil(
      async () => {
        const ready = await page.evaluate("document.readyState === 'complete'");
        return ready && workspacePreviewLoaded(page, previewUrl);
      },
      { timeoutMs: 30_000, message: "Preview URL was not restored after workspace reload." }
    );

    await page.navigate(previewUrl);
    const interactions = await page.evaluate(todoInteractionScript);

    await page.navigate(workspaceUrl);
    await waitUntil(() => page.evaluate("Boolean(document.querySelector('iframe'))"), {
      timeoutMs: 30_000,
      message: "Workspace did not render a Preview iframe before restart."
    });
    await page.evaluate(fetchProbeScript);
    await waitUntil(
      () =>
        page.evaluate(`(() => {
          const button = [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === "Restart");
          return Boolean(button && !button.disabled && button.dataset.runtimeReady === "true");
        })()`),
      { timeoutMs: 30_000, message: "Restart Preview button did not become interactive." }
    );
    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === "Restart");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, "Restart Preview button was unavailable.");
    const restartRequest = await waitUntil(
      () =>
        page.evaluate(`(() => {
          return window.__atomAcceptance.fetches.find(
            (entry) => entry.method === "POST" && entry.path.endsWith("/runtime/restart")
          );
        })()`),
      { timeoutMs: 30_000, intervalMs: 250, message: "Workspace did not queue a restart." }
    );
    assert.equal(
      restartRequest.status,
      202,
      `Workspace restart request returned HTTP ${restartRequest.status}: ${restartRequest.body?.error ?? "unknown error"}`
    );
    assert.match(
      restartRequest.body?.runtimeJobId ?? "",
      /^[0-9a-f-]{36}$/i,
      "Workspace restart response did not include a Runtime Job ID."
    );
    const runtimeJobId = restartRequest.body.runtimeJobId;
    const terminalJob = await waitUntil(
      async () => {
        const state = await page.evaluate(`(() => {
          const runtimeJobId = ${JSON.stringify(runtimeJobId)};
          const jobs = window.__atomAcceptance.fetches.filter(
            (entry) => entry.method === "GET" && entry.path.endsWith("/runtime-jobs/" + runtimeJobId)
          );
          const terminal = jobs.find((entry) => ["completed", "failed"].includes(entry.body?.status));
          const uiFailed = document.body.innerText.includes("Preview restart failed");
          return { terminal, uiFailed, lastStatus: jobs.at(-1)?.body?.status };
        })()`);
        if (state.terminal || state.uiFailed) return state;
        throw new Error(
          `Runtime Job ${runtimeJobId.slice(0, 8)} last status: ${state.lastStatus ?? "not observed"}.`
        );
      },
      {
        timeoutMs: restartTimeoutMs,
        intervalMs: 500,
        message: "Workspace restart did not complete."
      }
    );
    assert.ok(terminalJob.terminal, "Workspace reported that Preview restart failed.");
    assert.notEqual(
      terminalJob.terminal.body?.status,
      "failed",
      [terminalJob.terminal.body?.errorCode, terminalJob.terminal.body?.errorMessage]
        .filter(Boolean)
        .join(": ") || "Worker Preview restart failed."
    );
    const completedJob = terminalJob.terminal;
    assert.equal(completedJob.body?.operation, "restart_preview");
    await waitUntil(() => page.evaluate(`document.body.innerText.includes("Preview restarted")`), {
      timeoutMs: 10_000,
      message: "Workspace did not render the restart success result."
    });
    const restartedPreviewUrl = completedJob?.body?.previewUrl;
    assert.ok(restartedPreviewUrl, "Completed restart job did not include a Preview URL.");
    const restartedPreview = await fetch(restartedPreviewUrl, {
      signal: AbortSignal.timeout(30_000)
    });
    const initialPreview = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });
    const workspace = await fetch(workspaceUrl, {
      headers: { Cookie: cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    });
    const evidence = validatePreviewAcceptanceEvidence({
      projectId,
      runId,
      previewUrl,
      previewHttpStatus: initialPreview.status,
      workspaceHttpStatus: workspace.status,
      iframeLoaded: Boolean(iframeLoaded && previewResponses.some((status) => status === 200)),
      reloadRestored: Boolean(reloadRestored),
      interactions,
      restartQueued: Boolean(restartRequest?.body?.runtimeJobId),
      restartCompleted: Boolean(completedJob),
      restartedPreviewUrl,
      restartedPreviewHttpStatus: restartedPreview.status,
      browserSecurityErrors: securityErrors.length,
      previewMutationRequests: mutationRequests.length
    });
    return evidence;
  } finally {
    removeListeners.forEach((remove) => remove());
    await page.close().catch(() => undefined);
    await browser.close();
  }
}
