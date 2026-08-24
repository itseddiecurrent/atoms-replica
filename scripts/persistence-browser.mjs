import assert from "node:assert/strict";

import {
  createPage,
  incrementalInteractionScript,
  launchBrowser,
  waitUntil
} from "./preview-acceptance.mjs";

function sessionCookieParts(cookie) {
  const [name, ...value] = cookie.split("=");
  return { name, value: value.join("=") };
}

async function setSessionCookie(connection, page, baseUrl, cookie) {
  const { name, value } = sessionCookieParts(cookie);
  await connection.send(
    "Network.setCookie",
    {
      name,
      value,
      domain: new URL(baseUrl).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax"
    },
    page.sessionId
  );
}

const workspaceStateExpression = ({
  projectId,
  previewUrl,
  expectedMessages,
  expectedPlanSummary
}) => `(() => {
  const body = document.body.innerText;
  const appButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "App.tsx"
  );
  return {
    projectVisible: body.includes(${JSON.stringify(projectId)}),
    conversationVisible: ${JSON.stringify(expectedMessages)}.every((message) => body.includes(message)),
    planVisible: body.includes(${JSON.stringify(expectedPlanSummary)}),
    finalStatusVisible: body.includes("Running") && body.includes("Generated and saved"),
    fileTreeVisible: Boolean(appButton),
    previewVisible: body.includes(${JSON.stringify(previewUrl)}) && Boolean(document.querySelector("iframe"))
  };
})()`;

async function readWorkspaceState(page, input) {
  const state = await page.evaluate(workspaceStateExpression(input));
  const appClicked = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent.trim() === "App.tsx"
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(appClicked, true, "Workspace did not expose src/App.tsx in the file tree.");
  const source = await waitUntil(
    () =>
      page.evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="Editing src/App.tsx"]');
        const version = [...document.querySelectorAll("span")].find((element) => /^Version \\d+$/.test(element.textContent.trim()));
        return editor ? { nonEmpty: Boolean(editor.value.trim()), versionVisible: Boolean(version) } : undefined;
      })()`),
    { timeoutMs: 30_000, message: "Workspace did not restore the src/App.tsx editor." }
  );
  return { ...state, sourceRestored: source.nonEmpty, fileVersionVisible: source.versionVisible };
}

const loginScript = ({ email, password }) => `(async () => {
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const email = document.querySelector('input[type="email"]');
  const password = document.querySelector('input[type="password"]');
  const submit = [...document.querySelectorAll('button[type="submit"]')].find((button) => button.textContent.trim() === "Sign in");
  if (!email || !password || !submit) return false;
  setValue(email, ${JSON.stringify(email)});
  setValue(password, ${JSON.stringify(password)});
  submit.click();
  return true;
})()`;

export async function runPersistenceReloginBrowserAcceptance({
  baseUrl,
  projectId,
  previewUrl,
  cookie,
  email,
  password,
  expectedMessages,
  expectedPlanSummary,
  executablePath
}) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  try {
    await setSessionCookie(browser.connection, page, baseUrl, cookie);
    const workspaceUrl = `${baseUrl}/projects/${projectId}`;
    await page.navigate(workspaceUrl);
    const stateInput = { projectId, previewUrl, expectedMessages, expectedPlanSummary };
    const initial = await readWorkspaceState(page, stateInput);

    await browser.connection.send("Page.reload", { ignoreCache: true }, page.sessionId);
    await waitUntil(() => page.evaluate("document.readyState === 'complete'"));
    const reloaded = await readWorkspaceState(page, stateInput);

    await page.navigate(`${baseUrl}/projects`);
    const dashboardBeforeLogout = await waitUntil(
      () => page.evaluate(`document.body.innerText.includes(${JSON.stringify(projectId)})`),
      {
        timeoutMs: 30_000,
        message: "Dashboard did not render the checkpoint Project before logout."
      }
    );
    const signedOut = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Sign out");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(signedOut, true, "Dashboard did not expose Sign out.");
    await waitUntil(
      () =>
        page.evaluate(
          `location.pathname === "/login" && document.body.innerText.includes("Welcome back")`
        ),
      { timeoutMs: 30_000, message: "Sign out did not return to the login page." }
    );
    assert.equal(
      await page.evaluate(loginScript({ email, password })),
      true,
      "Login form was unavailable."
    );
    await waitUntil(() => page.evaluate(`location.pathname === "/projects"`), {
      timeoutMs: 30_000,
      message: "Dedicated account did not return to the Dashboard after login."
    });
    const dashboardAfterLogin = await waitUntil(
      () => page.evaluate(`document.body.innerText.includes(${JSON.stringify(projectId)})`),
      {
        timeoutMs: 30_000,
        message: "Dashboard did not restore the checkpoint Project after login."
      }
    );
    await page.navigate(workspaceUrl);
    const relogged = await readWorkspaceState(page, stateInput);
    const { name } = sessionCookieParts(cookie);
    const cookies = await browser.connection.send(
      "Network.getCookies",
      { urls: [baseUrl] },
      page.sessionId
    );
    const renewed = cookies.cookies?.find((candidate) => candidate.name === name);
    assert.ok(renewed?.value, "Re-login did not create a new server session cookie.");

    return {
      initial,
      reloaded,
      relogged,
      dashboardBeforeLogout: Boolean(dashboardBeforeLogout),
      dashboardAfterLogin: Boolean(dashboardAfterLogin),
      signedOut: true,
      signedIn: true,
      cookie: `${name}=${renewed.value}`
    };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close();
  }
}

const runtimeFetchProbe = String.raw`(() => {
  const original = window.fetch.bind(window);
  window.__atomPersistenceFetches = [];
  window.fetch = async (...args) => {
    const request = args[0];
    const options = args[1] || {};
    const url = typeof request === "string" ? request : request.url;
    const method = String(options.method || (typeof request === "string" ? "GET" : request.method) || "GET").toUpperCase();
    const response = await original(...args);
    if (/\/api\/(projects\/[^/]+\/(runtime\/restart|files\/content)|runtime-jobs\/)/.test(url)) {
      let body;
      try { body = await response.clone().json(); } catch {}
      window.__atomPersistenceFetches.push({
        path: new URL(url, location.href).pathname,
        method,
        status: response.status,
        body: body ? {
          runtimeJobId: body.runtimeJobId,
          status: body.status,
          operation: body.resultJson?.operation,
          previewUrl: body.resultJson?.previewUrl,
          version: body.version,
          errorCode: body.errorCode,
          errorMessage: body.errorMessage
        } : undefined
      });
    }
    return response;
  };
})()`;

async function waitForRuntimeJobFromUi(page, runtimeJobId, timeoutMs) {
  const state = await waitUntil(
    () =>
      page.evaluate(`(() => {
        const jobs = window.__atomPersistenceFetches.filter(
          (entry) => entry.method === "GET" && entry.path.endsWith("/runtime-jobs/${runtimeJobId}")
        );
        return jobs.find((entry) => ["completed", "failed"].includes(entry.body?.status));
      })()`),
    {
      timeoutMs,
      intervalMs: 500,
      message: `Runtime Job ${runtimeJobId.slice(0, 8)} did not complete.`
    }
  );
  assert.equal(
    state.body?.status,
    "completed",
    [state.body?.errorCode, state.body?.errorMessage].filter(Boolean).join(": ") ||
      "Runtime operation failed."
  );
  return state;
}

export async function runExpiredSandboxRestoreBrowserAcceptance({
  baseUrl,
  projectId,
  cookie,
  timeoutMs = 6 * 60_000,
  executablePath
}) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  try {
    await setSessionCookie(browser.connection, page, baseUrl, cookie);
    await page.navigate(`${baseUrl}/projects/${projectId}`);
    await page.evaluate(runtimeFetchProbe);
    await waitUntil(
      () =>
        page.evaluate(`(() => {
          const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Restart");
          return Boolean(button && !button.disabled && button.dataset.runtimeReady === "true");
        })()`),
      { timeoutMs: 30_000, message: "Restart button did not become interactive after expiry." }
    );
    await page.evaluate(
      `([...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Restart")).click()`
    );
    const request = await waitUntil(
      () =>
        page.evaluate(
          `window.__atomPersistenceFetches.find((entry) => entry.method === "POST" && entry.path.endsWith("/runtime/restart"))`
        ),
      { timeoutMs: 30_000, message: "Workspace did not queue expired Sandbox restoration." }
    );
    assert.equal(request.status, 202);
    assert.match(request.body?.runtimeJobId ?? "", /^[0-9a-f-]{36}$/i);
    const terminal = await waitForRuntimeJobFromUi(page, request.body.runtimeJobId, timeoutMs);
    await waitUntil(() => page.evaluate(`document.body.innerText.includes("Preview restarted")`), {
      timeoutMs: 10_000,
      message: "Workspace did not display the restoration result."
    });
    const previewUrl = terminal.body?.previewUrl;
    assert.match(previewUrl ?? "", /^https:\/\//);
    return { runtimeJobId: request.body.runtimeJobId, previewUrl, restoredByUi: true };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close();
  }
}

export async function runIdeEditBrowserAcceptance({
  baseUrl,
  projectId,
  previewUrl,
  cookie,
  marker,
  timeoutMs = 6 * 60_000,
  executablePath
}) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  const securityErrors = [];
  const mutationRequests = [];
  const removers = [
    browser.connection.on(
      "Network.loadingFailed",
      (event) => {
        if (/(csp|mixed-content|origin)/i.test(String(event.blockedReason ?? "")))
          securityErrors.push(event.blockedReason);
      },
      page.sessionId
    ),
    browser.connection.on(
      "Network.requestWillBeSent",
      ({ request }) => {
        if (
          new URL(request.url).origin === new URL(previewUrl).origin &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        )
          mutationRequests.push(request.method);
      },
      page.sessionId
    )
  ];
  try {
    await setSessionCookie(browser.connection, page, baseUrl, cookie);
    await page.navigate(`${baseUrl}/projects/${projectId}`);
    await page.evaluate(runtimeFetchProbe);
    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "styles.css");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true);
    await waitUntil(
      () =>
        page.evaluate(
          `Boolean(document.querySelector('textarea[aria-label="Editing src/styles.css"]'))`
        ),
      { timeoutMs: 30_000, message: "IDE did not load src/styles.css." }
    );
    const edited = await page.evaluate(`(() => {
      const editor = document.querySelector('textarea[aria-label="Editing src/styles.css"]');
      if (!editor || !editor.value.trim()) return false;
      const value = editor.value + ${JSON.stringify(`\n\nbody::after {\n  content: "${marker}";\n  position: fixed;\n  right: 12px;\n  bottom: 8px;\n  color: #71717a;\n  font-size: 11px;\n}\n`)};
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, value);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(marker)}, inputType: "insertText" }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    assert.equal(edited, true, "IDE could not apply the harmless visible marker.");
    await waitUntil(
      () =>
        page.evaluate(
          `Boolean([...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save" && !button.disabled))`
        ),
      { timeoutMs: 10_000, message: "IDE Save button did not enable." }
    );
    await page.evaluate(
      `([...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save")).click()`
    );
    const save = await waitUntil(
      () =>
        page.evaluate(
          `window.__atomPersistenceFetches.find((entry) => entry.method === "PUT" && entry.path.endsWith("/files/content"))`
        ),
      { timeoutMs: 30_000, message: "IDE did not save the edited file." }
    );
    assert.equal(save.status, 200);
    assert.match(save.body?.runtimeJobId ?? "", /^[0-9a-f-]{36}$/i);
    await waitForRuntimeJobFromUi(page, save.body.runtimeJobId, timeoutMs);
    await waitUntil(
      () => page.evaluate(`document.body.innerText.includes("File synchronized to Preview")`),
      {
        timeoutMs: 10_000,
        message: "IDE did not display successful Preview synchronization."
      }
    );
    await page.navigate(previewUrl);
    const markerVisible = await waitUntil(
      () =>
        page.evaluate(
          `getComputedStyle(document.body, "::after").content.includes(${JSON.stringify(marker)})`
        ),
      { timeoutMs: 30_000, message: "Rebuilt Preview did not show the IDE edit." }
    );
    const interactions = await page.evaluate(incrementalInteractionScript);
    return {
      runtimeJobId: save.body.runtimeJobId,
      savedVersion: save.body.version,
      markerVisible: Boolean(markerVisible),
      interactions,
      browserSecurityErrors: securityErrors.length,
      previewMutationRequests: mutationRequests.length
    };
  } finally {
    removers.forEach((remove) => remove());
    await page.close().catch(() => undefined);
    await browser.close();
  }
}

export async function runStandaloneTodoBrowserAcceptance({ url, marker, executablePath }) {
  const browser = await launchBrowser({ ...(executablePath ? { executablePath } : {}) });
  const page = await createPage(browser.connection);
  try {
    await page.navigate(url);
    const markerVisible = marker
      ? await page.evaluate(
          `getComputedStyle(document.body, "::after").content.includes(${JSON.stringify(marker)})`
        )
      : true;
    const interactions = await page.evaluate(incrementalInteractionScript);
    return { markerVisible: Boolean(markerVisible), interactions };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close();
  }
}
