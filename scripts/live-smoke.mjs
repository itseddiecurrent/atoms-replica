import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";

import {
  formatGenerationRunnerProgress,
  formatFirstGenerationReport,
  productionBaseUrl,
  validateFirstGenerationEvidence
} from "./first-generation-evidence.mjs";
import {
  formatPreviewAcceptanceReport,
  runIncrementalPreviewBrowserAcceptance,
  runPreviewBrowserAcceptance
} from "./preview-acceptance.mjs";
import {
  formatIncrementalAcceptanceReport,
  validateIncrementalAcceptanceEvidence
} from "./incremental-acceptance.mjs";
import {
  formatPersistenceCheckpointReport,
  formatPersistenceAcceptanceReport,
  isUnsafeDownloadPath,
  readStoredZip,
  resolvePersistenceCheckpoint,
  validatePersistenceAcceptanceEvidence
} from "./persistence-acceptance.mjs";
import {
  runExpiredSandboxRestoreBrowserAcceptance,
  runIdeEditBrowserAcceptance,
  runPersistenceReloginBrowserAcceptance,
  runStandaloneTodoBrowserAcceptance
} from "./persistence-browser.mjs";

for (const path of [".env", ".env.test-account"]) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const fixedPrompt = "创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。";
const followUpPrompt = "把页面标题改成 Focus Todo，并增加 All、Active、Completed 三个筛选按钮。";
const persistenceOnly = process.env.E2E_PERSISTENCE_ONLY === "true";
const persistencePhase = persistenceOnly
  ? (process.env.E2E_PERSISTENCE_PHASE ?? (process.env.RAILWAY_GIT_COMMIT_SHA ? "prepare" : "full"))
  : undefined;
assert.ok(
  !persistenceOnly || ["prepare", "resume", "full"].includes(persistencePhase),
  "E2E_PERSISTENCE_PHASE must be prepare, resume, or full."
);
const acceptanceRunnerRelease = persistenceOnly
  ? `step8-persistence-recovery-download-v2-${persistencePhase}`
  : "step7-incremental-modification-v1";
const baseUrl = productionBaseUrl(required("E2E_BASE_URL"));
const email = required("E2E_EMAIL");
const password = required("E2E_PASSWORD");
const firebaseApiKey = process.env.E2E_FIREBASE_API_KEY ?? required("NEXT_PUBLIC_FIREBASE_API_KEY");
const maxWaitMs = Number(process.env.E2E_MAX_WAIT_MS ?? 12 * 60_000);
const deploySettleMs = Number(
  persistencePhase === "resume"
    ? 0
    : (process.env.E2E_DEPLOY_SETTLE_MS ?? (process.env.RAILWAY_GIT_COMMIT_SHA ? 120_000 : 0))
);
const initialOnly = process.env.E2E_INITIAL_ONLY === "true";
const previewOnly = process.env.E2E_PREVIEW_ONLY === "true";
const incrementalOnly = process.env.E2E_INCREMENTAL_ONLY === "true" || persistenceOnly;
let projectId;
let cookie;
let preserveProject = false;

function boundedFailure(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const secrets = [password, firebaseApiKey, email, cookie].filter(Boolean);
  return secrets
    .reduce((message, secret) => message.split(secret).join("<redacted>"), raw)
    .replaceAll(/\s+/g, " ")
    .slice(0, 2_000);
}

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

async function collectFileEvidence() {
  const files = (await jsonRequest(`/api/projects/${projectId}/files`)).body.files;
  return Promise.all(
    files.map(async (file) => {
      const saved = (
        await jsonRequest(
          `/api/projects/${projectId}/files/content?path=${encodeURIComponent(file.path)}`
        )
      ).body;
      return {
        path: file.path,
        version: saved.version,
        contentHash: createHash("sha256").update(saved.content).digest("hex")
      };
    })
  );
}

async function collectProjectFiles() {
  const files = (await jsonRequest(`/api/projects/${projectId}/files`)).body.files;
  return Promise.all(
    files.map(async (file) => {
      const saved = (
        await jsonRequest(
          `/api/projects/${projectId}/files/content?path=${encodeURIComponent(file.path)}`
        )
      ).body;
      return { path: file.path, version: saved.version, content: saved.content };
    })
  );
}

async function persistenceState() {
  return (await jsonRequest(`/api/projects/${projectId}/persistence`)).body;
}

async function waitForSandboxExpiry(expiresAt) {
  const graceMs = Number(process.env.E2E_SANDBOX_EXPIRY_GRACE_MS ?? 5_000);
  const deadline = new Date(expiresAt).getTime() + graceMs;
  assert.ok(Number.isFinite(deadline), "Project did not record a valid Sandbox expiry.");
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    console.info(
      `       Waiting for real Sandbox expiry: ${Math.ceil(remaining / 1_000)}s remaining.`
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 60_000)));
  }
}

function runProcess(command, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? -1, signal, output });
    });
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port, "Could not reserve a local acceptance port.");
  return port;
}

async function validateDownloadedProject(files, marker) {
  const directory = await mkdtemp(join(tmpdir(), "atom-download-acceptance-"));
  let server;
  try {
    for (const file of files) {
      assert.equal(isUnsafeDownloadPath(file.path), false, `Unsafe download path: ${file.path}`);
      const destination = join(directory, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
    const install = await runProcess("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: directory
    });
    assert.equal(install.exitCode, 0, "Clean downloaded project dependency installation failed.");
    const build = await runProcess("npm", ["run", "build"], { cwd: directory });
    assert.equal(build.exitCode, 0, "Clean downloaded project production build failed.");
    const test = await runProcess("npm", ["test"], { cwd: directory });
    assert.equal(test.exitCode, 0, "Clean downloaded project tests failed.");

    const port = await availablePort();
    server = spawn(
      "npm",
      ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: directory, env: { ...process.env, NODE_ENV: "development" }, stdio: "ignore" }
    );
    const url = `http://127.0.0.1:${port}`;
    let serverHttpStatus;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        serverHttpStatus = response.status;
        if (response.status === 200) break;
      } catch {
        // The clean Vite process may not have bound its port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(serverHttpStatus, 200, "Downloaded project did not start independently.");
    const browser = await runStandaloneTodoBrowserAcceptance({ url, marker });
    return {
      installExitCode: install.exitCode,
      buildExitCode: build.exitCode,
      testExitCode: test.exitCode,
      serverHttpStatus,
      ...browser
    };
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => server.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function completePersistenceAcceptance({
  checkpoint,
  browser,
  beforeExpiry,
  expectedInteractions
}) {
  console.info("9/10 Waiting for expiry, restoring, editing, downloading, and running clean...");
  await waitForSandboxExpiry(checkpoint.sandboxExpiresAt);
  console.info("       Sandbox expiry reached; requesting UI restoration from durable state...");
  const restore = await runExpiredSandboxRestoreBrowserAcceptance({
    baseUrl,
    projectId,
    cookie,
    timeoutMs: Math.min(maxWaitMs, 6 * 60_000)
  });
  console.info(
    "       Restoration completed; validating the new Preview and incremental result..."
  );
  const restoredPreview = await fetch(restore.previewUrl, {
    signal: AbortSignal.timeout(30_000)
  });
  const restoredBrowser = await runStandaloneTodoBrowserAcceptance({ url: restore.previewUrl });
  const afterRestore = await persistenceState();
  const marker = "Persistence restored";
  console.info("       Applying the visible IDE edit through a durable Runtime Job...");
  const ide = await runIdeEditBrowserAcceptance({
    baseUrl,
    projectId,
    previewUrl: restore.previewUrl,
    cookie,
    marker,
    timeoutMs: Math.min(maxWaitMs, 6 * 60_000)
  });
  const afterIdeSave = await persistenceState();

  console.info("       Downloading and validating the final project in a clean directory...");
  const serverFiles = await collectProjectFiles();
  const downloadResponse = await fetch(`${baseUrl}/api/projects/${projectId}/download`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(downloadResponse.status, 200);
  const downloadedFiles = readStoredZip(new Uint8Array(await downloadResponse.arrayBuffer()));
  const unsafePaths = downloadedFiles.map(({ path }) => path).filter(isUnsafeDownloadPath);
  const serverContents = new Map(serverFiles.map((file) => [file.path, file.content]));
  const filesMatchServer =
    downloadedFiles.length === serverFiles.length &&
    downloadedFiles.every((file) => serverContents.get(file.path) === file.content);
  const clean = await validateDownloadedProject(downloadedFiles, marker);
  const persistenceEvidence = validatePersistenceAcceptanceEvidence({
    projectId,
    initialRunId: checkpoint.initialRunId,
    followUpRunId: checkpoint.followUpRunId,
    initialSnapshotId: checkpoint.initialSnapshotId,
    followUpSnapshotId: checkpoint.followUpSnapshotId,
    browser,
    beforeExpiry,
    afterRestore,
    afterIdeSave,
    restore: {
      ...restore,
      previewHttpStatus: restoredPreview.status,
      incrementalResultVisible:
        restoredBrowser.interactions.titleVisible && restoredBrowser.interactions.filtersVisible
    },
    ide,
    download: {
      filesMatchServer,
      fileCount: downloadedFiles.length,
      unsafePaths,
      ...clean
    },
    expectedInteractions: expectedInteractions ?? restoredBrowser.interactions
  });
  console.info(formatPersistenceAcceptanceReport(persistenceEvidence));
  console.info("10/10 Cleaning up the persistence acceptance project...");
  await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
  projectId = undefined;
  console.info("Persistence, recovery, and download production acceptance passed.");
  process.exitCode = 0;
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

  if (persistencePhase === "resume") {
    console.info("3/10 Loading the exact persistence checkpoint from the prepare deployment...");
    projectId = required("E2E_PERSISTENCE_PROJECT_ID");
    const beforeExpiry = await persistenceState();
    const checkpoint = resolvePersistenceCheckpoint(beforeExpiry);
    assert.equal(
      checkpoint.projectId,
      projectId,
      "Resume checkpoint did not match E2E_PERSISTENCE_PROJECT_ID."
    );
    console.info("8/10 Re-verifying reload, logout/login, and complete server recovery...");
    const relogin = await runPersistenceReloginBrowserAcceptance({
      baseUrl,
      projectId,
      previewUrl: checkpoint.previewUrl,
      cookie,
      email,
      password,
      expectedMessages: [fixedPrompt, followUpPrompt],
      expectedPlanSummary: checkpoint.followUpPlanSummary
    });
    cookie = relogin.cookie;
    const browser = { ...relogin, cookie: undefined };
    await completePersistenceAcceptance({ checkpoint, browser, beforeExpiry });
  } else {
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
      if (previewOnly) {
        console.info(
          "5/10 Exercising Preview interactions, reload recovery, CSP, and UI restart..."
        );
        const previewEvidence = await runPreviewBrowserAcceptance({
          baseUrl,
          projectId,
          runId: created.body.runId,
          previewUrl: initial.previewUrl,
          cookie,
          restartTimeoutMs: Math.min(maxWaitMs, 6 * 60_000)
        });
        console.info(formatPreviewAcceptanceReport(previewEvidence));
        console.info("Cleaning up the Preview acceptance project...");
        await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
        projectId = undefined;
        console.info("Preview production acceptance passed.");
        process.exitCode = 0;
      } else {
        const beforeFiles = await collectFileEvidence();
        const initialCompleted = initial.events.findLast((event) => event.type === "run.completed");
        const initialSnapshotId = initialCompleted?.payload?.snapshotId;
        assert.ok(initialSnapshotId, "Initial Run did not record its Snapshot ID.");

        if (!incrementalOnly) {
          console.info(
            "5/10 Exercising Preview interactions, reload recovery, CSP, and UI restart..."
          );
          const previewEvidence = await runPreviewBrowserAcceptance({
            baseUrl,
            projectId,
            runId: created.body.runId,
            previewUrl: initial.previewUrl,
            cookie,
            restartTimeoutMs: Math.min(maxWaitMs, 6 * 60_000)
          });
          console.info(formatPreviewAcceptanceReport(previewEvidence));
        }

        console.info("6/10 Applying the fixed same-project follow-up change...");
        const followUp = await jsonRequest(`/api/projects/${projectId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: followUpPrompt })
        });
        const updated = await consumeRun(followUp.body.runId);
        assert.ok(updated.previewUrl, "Follow-up Run did not publish an updated Preview URL.");

        if (incrementalOnly) {
          console.info(
            "7/10 Verifying versions, Snapshot continuity, conversation, and UI behavior..."
          );
          const afterFiles = await collectFileEvidence();
          const followUpCompleted = updated.events.findLast(
            (event) => event.type === "run.completed"
          );
          const followUpSnapshotId = followUpCompleted?.payload?.snapshotId;
          assert.ok(followUpSnapshotId, "Follow-up Run did not record its Snapshot ID.");
          let preparedState;
          let preparedCheckpoint;
          if (persistenceOnly && persistencePhase === "prepare") {
            preparedState = await persistenceState();
            preparedCheckpoint = resolvePersistenceCheckpoint(preparedState);
            preserveProject = true;
            console.info(formatPersistenceCheckpointReport(preparedState));
            console.info(
              "       Durable checkpoint secured before browser verification; handled browser failures will preserve this Project."
            );
          }
          console.info("       Starting Chromium incremental behavior verification...");
          const browserEvidence = await runIncrementalPreviewBrowserAcceptance({
            baseUrl,
            projectId,
            previewUrl: updated.previewUrl,
            cookie,
            expectedMessages: [fixedPrompt, followUpPrompt]
          });
          console.info("       Chromium incremental behavior verification passed.");
          const preview = await fetch(updated.previewUrl, { signal: AbortSignal.timeout(30_000) });
          const incrementalEvidence = validateIncrementalAcceptanceEvidence({
            projectId,
            initialRunId: created.body.runId,
            followUpMessageId: followUp.body.messageId,
            followUpRunId: followUp.body.runId,
            initialSnapshotId,
            followUpSnapshotId,
            events: updated.events,
            beforeFiles,
            afterFiles,
            previewUrl: updated.previewUrl,
            previewHttpStatus: preview.status,
            ...browserEvidence
          });
          console.info(formatIncrementalAcceptanceReport(incrementalEvidence));
          if (persistenceOnly) {
            console.info("8/10 Verifying reload, logout/login, and complete server recovery...");
            const beforeExpiry = preparedState ?? (await persistenceState());
            const checkpoint = preparedCheckpoint ?? resolvePersistenceCheckpoint(beforeExpiry);
            assert.deepEqual(
              {
                initialRunId: checkpoint.initialRunId,
                followUpRunId: checkpoint.followUpRunId,
                initialSnapshotId: checkpoint.initialSnapshotId,
                followUpSnapshotId: checkpoint.followUpSnapshotId
              },
              {
                initialRunId: created.body.runId,
                followUpRunId: followUp.body.runId,
                initialSnapshotId,
                followUpSnapshotId
              },
              "Durable checkpoint IDs did not match the completed Runs."
            );
            const relogin = await runPersistenceReloginBrowserAcceptance({
              baseUrl,
              projectId,
              previewUrl: updated.previewUrl,
              cookie,
              email,
              password,
              expectedMessages: [fixedPrompt, followUpPrompt],
              expectedPlanSummary: checkpoint.followUpPlanSummary
            });
            cookie = relogin.cookie;
            const browser = { ...relogin, cookie: undefined };
            if (persistencePhase === "prepare") {
              console.info(
                "Persistence prepare deployment passed reload/logout/login verification and preserved the exact checkpoint project."
              );
              process.exitCode = 0;
            } else {
              await completePersistenceAcceptance({
                checkpoint,
                browser,
                beforeExpiry,
                expectedInteractions: incrementalEvidence.interactions
              });
            }
          } else {
            console.info("Cleaning up the incremental acceptance project...");
            await jsonRequest(`/api/projects/${projectId}`, { method: "DELETE" });
            projectId = undefined;
            console.info("Incremental modification production acceptance passed.");
            process.exitCode = 0;
          }
        } else {
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
    }
  }
} catch (error) {
  console.error(`Acceptance runner failed before cleanup: ${boundedFailure(error)}`);
  throw error;
} finally {
  if (projectId && cookie && !preserveProject) {
    await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { Cookie: cookie }
    }).catch(() => undefined);
  }
}
