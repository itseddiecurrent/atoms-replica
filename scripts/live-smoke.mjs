import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";

import {
  formatGenerationRunnerProgress,
  formatFirstGenerationReport,
  productionBaseUrl,
  validateFirstGenerationEvidence
} from "./first-generation-evidence.mjs";
import {
  formatPreviewAcceptanceReport,
  runPreviewBrowserAcceptance
} from "./preview-acceptance.mjs";

for (const path of [".env", ".env.test-account"]) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const fixedPrompt = "创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。";
const acceptanceRunnerRelease = "step6-browser-preview-interaction-v11";
const baseUrl = productionBaseUrl(required("E2E_BASE_URL"));
const email = required("E2E_EMAIL");
const password = required("E2E_PASSWORD");
const firebaseApiKey = process.env.E2E_FIREBASE_API_KEY ?? required("NEXT_PUBLIC_FIREBASE_API_KEY");
const maxWaitMs = Number(process.env.E2E_MAX_WAIT_MS ?? 12 * 60_000);
const deploySettleMs = Number(
  process.env.E2E_DEPLOY_SETTLE_MS ?? (process.env.RAILWAY_GIT_COMMIT_SHA ? 120_000 : 0)
);
const initialOnly = process.env.E2E_INITIAL_ONLY === "true";
const previewOnly = process.env.E2E_PREVIEW_ONLY === "true";
let projectId;
let cookie;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live smoke test.`);
  return value;
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`
    );
  return { response, body };
}

function parseSseBlock(block) {
  const id = block.match(/^id:\s*(\d+)/m)?.[1];
  const event = block.match(/^event:\s*(.+)$/m)?.[1];
  const data = block.match(/^data:\s*(.+)$/m)?.[1];
  if (!id || !event || !data) return undefined;
  return { id: Number(id), event, data: JSON.parse(data) };
}

async function consumeRun(runId, { reconnectAfterFirstEvent = false } = {}) {
  const deadline = Date.now() + maxWaitMs;
  const startedAt = Date.now();
  let lastEventId = 0;
  let lastEventType = "none";
  let previewUrl;
  let reconnectPending = reconnectAfterFirstEvent;
  const events = [];
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
    console.info(
      `       Still waiting for Run ${runId.slice(0, 8)} after ${elapsedSeconds}s; last event: ${lastEventType}.`
    );
  }, 30_000);
  try {
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = setTimeout(() => controller.abort(), remaining);
      let response;
      try {
        response = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
          headers: {
            Cookie: cookie,
            Accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": String(lastEventId) } : {})
          },
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        if (Date.now() >= deadline) throw error;
        console.info(`       SSE connection interrupted; resuming after event ${lastEventId}.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      assert.equal(response.status, 200, `SSE returned ${response.status}`);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let forceReconnect = false;
      let transportInterrupted = false;
      try {
        while (Date.now() < deadline) {
          let packet;
          try {
            packet = await reader.read();
          } catch {
            transportInterrupted = true;
            break;
          }
          const { done, value } = packet;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseBlock(block);
            if (!parsed) continue;
            lastEventId = Math.max(lastEventId, parsed.id);
            lastEventType = parsed.event;
            events.push(parsed.data);
            const progress = formatGenerationRunnerProgress(parsed.data);
            if (progress) console.info(progress);
            if (parsed.event === "preview.ready") previewUrl = parsed.data.payload?.url;
            if (["run.failed", "run.cancelled"].includes(parsed.event))
              throw new Error(
                `Run ended as ${parsed.event}: ${JSON.stringify(parsed.data.payload)}`
              );
            if (parsed.event === "run.completed") return { previewUrl, lastEventId, events };
            if (reconnectPending) {
              reconnectPending = false;
              forceReconnect = true;
              await reader.cancel();
              break;
            }
          }
          if (forceReconnect) break;
        }
      } finally {
        clearTimeout(timeout);
        await reader.cancel().catch(() => undefined);
      }
      if (transportInterrupted) {
        console.info(`       SSE stream interrupted; resuming after event ${lastEventId}.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`Run ${runId} did not complete within ${maxWaitMs}ms.`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitForRuntimeJob(runtimeJobId) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { body } = await jsonRequest(`/api/runtime-jobs/${runtimeJobId}`);
    if (body.status === "completed") return body.resultJson ?? {};
    if (body.status === "failed") throw new Error(body.errorMessage ?? "Runtime job failed.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Runtime job ${runtimeJobId} timed out.`);
}

try {
  console.info(`Acceptance runner release: ${acceptanceRunnerRelease}`);
  console.info(
    `Acceptance runner commit: ${process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || "unavailable"}`
  );
  console.info("1/10 Checking production readiness...");
  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).database, "ok");
  if (deploySettleMs > 0) {
    console.info(
      `       Waiting ${Math.ceil(deploySettleMs / 1_000)}s for the Worker rollout to settle...`
    );
    await new Promise((resolve) => setTimeout(resolve, deploySettleMs));
    const settledHealth = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(10_000)
    });
    assert.equal(settledHealth.status, 200);
    assert.equal((await settledHealth.json()).database, "ok");
  }

  console.info("2/10 Signing in through Firebase and creating a server session...");
  const firebase = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  const firebaseBody = await firebase.json();
  assert.equal(firebase.status, 200, JSON.stringify(firebaseBody));
  const session = await fetch(`${baseUrl}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: firebaseBody.idToken }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(session.status, 200);
  cookie = session.headers.get("set-cookie")?.match(/^([^;]+)/)?.[1];
  assert.ok(cookie, "Session response did not set a cookie.");

  console.info("3/10 Creating the fixed Todo App and testing SSE reconnection...");
  const created = await jsonRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify({ prompt: fixedPrompt })
  });
  projectId = created.body.projectId;
  const initial = await consumeRun(created.body.runId, { reconnectAfterFirstEvent: true });
  assert.ok(initial.previewUrl, "Initial run did not publish a Preview URL.");

  console.info("4/10 Checking the live Preview and generation evidence...");
  const preview = await fetch(initial.previewUrl, { signal: AbortSignal.timeout(30_000) });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /<html|<div[^>]+id=["']root/i);

  const initialFiles = (await jsonRequest(`/api/projects/${projectId}/files`)).body.files;
  const initialApp = initialFiles.find((file) => file.path === "src/App.tsx");
  assert.ok(initialApp, "Generated project is missing src/App.tsx.");
  const initialAppContent = (
    await jsonRequest(
      `/api/projects/${projectId}/files/content?path=${encodeURIComponent(initialApp.path)}`
    )
  ).body;
  const generationEvidence = validateFirstGenerationEvidence({
    projectId,
    runId: created.body.runId,
    events: initial.events,
    files: initialFiles.map((file) => ({
      path: file.path,
      content: file.path === initialApp.path ? initialAppContent.content : "persisted"
    })),
    previewUrl: initial.previewUrl
  });
  console.info(formatFirstGenerationReport(generationEvidence));

  if (initialOnly) {
    console.info("Cleaning up the initial-generation acceptance project...");
    await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
    projectId = undefined;
    console.info("First production generation acceptance passed.");
  } else {
    console.info("5/10 Exercising Preview interactions, reload recovery, CSP, and UI restart...");
    const previewEvidence = await runPreviewBrowserAcceptance({
      baseUrl,
      projectId,
      runId: created.body.runId,
      previewUrl: initial.previewUrl,
      cookie,
      restartTimeoutMs: Math.min(maxWaitMs, 6 * 60_000)
    });
    console.info(formatPreviewAcceptanceReport(previewEvidence));

    if (previewOnly) {
      console.info("Cleaning up the Preview acceptance project...");
      await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
      projectId = undefined;
      console.info("Preview production acceptance passed.");
      process.exitCode = 0;
    } else {
      console.info("6/10 Applying a follow-up Agent change...");
      const followUp = await jsonRequest(`/api/projects/${projectId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Add a visible count of remaining Todo items." })
      });
      await consumeRun(followUp.body.runId);

      console.info("7/10 Testing manual edit synchronization through the Worker...");
      const files = (await jsonRequest(`/api/projects/${projectId}/files`)).body.files;
      const target = files.find((file) => file.path === "src/App.tsx");
      assert.ok(target, "Generated project is missing src/App.tsx.");
      const current = (
        await jsonRequest(
          `/api/projects/${projectId}/files/content?path=${encodeURIComponent(target.path)}`
        )
      ).body;
      const saved = await jsonRequest(`/api/projects/${projectId}/files/content`, {
        method: "PUT",
        body: JSON.stringify({
          path: target.path,
          content: `${current.content}\n/* live-smoke-manual-edit */\n`,
          version: current.version
        })
      });
      await waitForRuntimeJob(saved.body.runtimeJobId);

      console.info("8/10 Testing direct Preview restart/recovery evidence...");
      const restart = await jsonRequest(`/api/projects/${projectId}/runtime/restart`, {
        method: "POST"
      });
      const restarted = await waitForRuntimeJob(restart.body.runtimeJobId);
      assert.ok(restarted.previewUrl, "Restart did not return a Preview URL.");

      console.info("9/10 Downloading and validating the source ZIP...");
      const download = await fetch(`${baseUrl}/api/projects/${projectId}/download`, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(30_000)
      });
      assert.equal(download.status, 200);
      const zip = new Uint8Array(await download.arrayBuffer());
      assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);

      console.info("10/10 Cleaning up the smoke-test project...");
      await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
      projectId = undefined;
      console.info("Live production smoke test passed.");
    }
  }
} finally {
  if (projectId && cookie) {
    await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { Cookie: cookie }
    }).catch(() => undefined);
  }
}
