import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

import {
  productionBaseUrl,
  validateFirstGenerationEvidence
} from "./first-generation-evidence.mjs";
import {
  formatProductionSmokeReport,
  requiredFailureContracts,
  validateProductionSmokeEvidence
} from "./production-smoke-acceptance.mjs";

for (const path of [".env", ".env.test-account"]) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const baseUrl = productionBaseUrl(required("E2E_BASE_URL"));
const firebaseApiKey = process.env.E2E_FIREBASE_API_KEY ?? required("NEXT_PUBLIC_FIREBASE_API_KEY");
const maxWaitMs = Number(process.env.E2E_MAX_WAIT_MS ?? 12 * 60_000);
const deploySettleMs = Number(
  process.env.E2E_DEPLOY_SETTLE_MS ?? (process.env.RAILWAY_GIT_COMMIT_SHA ? 120_000 : 0)
);
const prompt = "创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。";
let primaryCookie;
let secondaryCookie;
let secondaryIdToken;
let completedProjectId;
let cancelledProjectId;
const projectRunIds = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the production smoke test.`);
  return value;
}

function boundedFailure(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const secrets = [
    process.env.E2E_PASSWORD,
    firebaseApiKey,
    primaryCookie,
    secondaryCookie,
    secondaryIdToken
  ].filter(Boolean);
  return secrets
    .reduce((message, secret) => message.split(secret).join("<redacted>"), raw)
    .replaceAll(/\s+/g, " ")
    .slice(0, 2_000);
}

async function request(path, { cookie, method = "GET", body, redirect = "manual" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect,
    signal: AbortSignal.timeout(30_000)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const parsed = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : undefined;
  return { response, body: parsed };
}

async function requiredRequest(path, options = {}, status = 200) {
  const result = await request(path, options);
  assert.equal(
    result.response.status,
    status,
    `${options.method ?? "GET"} ${path} returned ${result.response.status}: ${JSON.stringify(result.body)}`
  );
  return result.body;
}

async function firebaseRequest(operation, body) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${operation}?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    }
  );
  const parsed = await response.json().catch(() => null);
  assert.equal(response.status, 200, `Firebase ${operation} returned ${response.status}.`);
  return parsed;
}

async function createSession(idToken) {
  const session = await request("/api/auth/session", {
    method: "POST",
    body: { idToken }
  });
  assert.equal(session.response.status, 200, "The Web session endpoint rejected Firebase auth.");
  const cookie = session.response.headers.get("set-cookie")?.match(/^([^;]+)/)?.[1];
  assert.ok(cookie, "The Web session endpoint did not issue a Session Cookie.");
  return cookie;
}

async function signInPrimary() {
  const auth = await firebaseRequest("signInWithPassword", {
    email: required("E2E_EMAIL"),
    password: required("E2E_PASSWORD"),
    returnSecureToken: true
  });
  return createSession(auth.idToken);
}

async function createSecondaryAccount() {
  const marker = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `atom-step9-${marker}@example.com`;
  const password = randomBytes(24).toString("base64url");
  const auth = await firebaseRequest("signUp", { email, password, returnSecureToken: true });
  secondaryIdToken = auth.idToken;
  secondaryCookie = await createSession(auth.idToken);
}

function parseSseBlock(block) {
  const id = block.match(/^id:\s*(\d+)/m)?.[1];
  const event = block.match(/^event:\s*(.+)$/m)?.[1];
  const data = block.match(/^data:\s*(.+)$/m)?.[1];
  if (!id || !event || !data) return undefined;
  return { id: Number(id), event, data: JSON.parse(data) };
}

async function consumeRun(runId, { expectedTerminal, onEvent, forceReconnect = false }) {
  const deadline = Date.now() + maxWaitMs;
  let cursor = 0;
  let reconnectPending = forceReconnect;
  let didReconnect = false;
  const events = [];
  const eventIds = [];
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let response;
    try {
      response = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
        headers: {
          Cookie: primaryCookie,
          Accept: "text/event-stream",
          ...(cursor ? { "Last-Event-ID": String(cursor) } : {})
        },
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    assert.equal(response.status, 200, `SSE returned ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reconnect = false;
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
          const parsed = parseSseBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (!parsed) continue;
          cursor = Math.max(cursor, parsed.id);
          eventIds.push(parsed.id);
          events.push(parsed.data);
          await onEvent?.(parsed.data);
          if (reconnectPending) {
            reconnectPending = false;
            didReconnect = true;
            reconnect = true;
            await reader.cancel();
            break;
          }
          if (["run.completed", "run.failed", "run.cancelled"].includes(parsed.event)) {
            assert.equal(parsed.event, expectedTerminal, `Run ended as ${parsed.event}.`);
            return { events, eventIds, forcedReconnect: didReconnect };
          }
        }
        if (reconnect) break;
      }
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => undefined);
    }
    if (transportInterrupted) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${runId} did not reach ${expectedTerminal} within ${maxWaitMs}ms.`);
}

async function waitForRuntimeJob(runtimeJobId) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const job = await requiredRequest(`/api/runtime-jobs/${runtimeJobId}`, {
      cookie: primaryCookie
    });
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Runtime Job ${runtimeJobId} did not finish.`);
}

async function deleteAndWait(projectId) {
  const deleted = await requiredRequest(
    `/api/projects/${projectId}`,
    { cookie: primaryCookie, method: "DELETE" },
    202
  );
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const job = await requiredRequest(`/api/resource-cleanups/${deleted.cleanupJobId}`, {
      cookie: primaryCookie
    });
    if (job.status === "completed") return job.status;
    if (job.status === "failed") throw new Error(`Resource cleanup failed: ${job.errorMessage}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Resource cleanup ${deleted.cleanupJobId} did not finish.`);
}

function accessRequests(projectId, runId, runtimeJobId, filePath) {
  return {
    project: { path: `/projects/${projectId}` },
    files: { path: `/api/projects/${projectId}/files` },
    fileContent: {
      path: `/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`
    },
    download: { path: `/api/projects/${projectId}/download` },
    persistence: { path: `/api/projects/${projectId}/persistence` },
    messages: {
      path: `/api/projects/${projectId}/messages`,
      method: "POST",
      body: { content: "Access-control probe" }
    },
    events: { path: `/api/runs/${runId}/events` },
    cancel: { path: `/api/runs/${runId}/cancel`, method: "POST" },
    runtimeRestart: { path: `/api/projects/${projectId}/runtime/restart`, method: "POST" },
    runtimeJob: { path: `/api/runtime-jobs/${runtimeJobId}` },
    delete: { path: `/api/projects/${projectId}`, method: "DELETE" }
  };
}

async function collectAccessMatrix(cookie, targets) {
  const matrix = {};
  for (const [surface, target] of Object.entries(targets)) {
    const result = await request(target.path, { ...target, cookie });
    let status = result.response.status;
    if (surface === "project" && status === 200) {
      const page = await result.response.text();
      if (/404|page could not be found|not found/i.test(page)) status = 404;
    }
    matrix[surface] = status;
    if (
      surface === "events" &&
      result.response.body &&
      result.response.headers.get("content-type")?.includes("text/event-stream")
    )
      await result.response.body.cancel();
  }
  return matrix;
}

async function fileState(projectId) {
  const body = await requiredRequest(`/api/projects/${projectId}/files`, {
    cookie: primaryCookie
  });
  return body.files.map(({ path, version }) => ({ path, version }));
}

try {
  console.info("Acceptance runner release: step9-production-smoke-faults-v1");
  console.info(
    `Acceptance runner commit: ${process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || "unavailable"}`
  );
  console.info("1/9 Checking production health and deployment stability...");
  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body?.database, "ok");
  if (deploySettleMs) {
    await new Promise((resolve) => setTimeout(resolve, deploySettleMs));
    const settledHealth = await request("/api/health");
    assert.equal(settledHealth.response.status, 200);
    assert.equal(settledHealth.body?.database, "ok");
  }

  console.info("2/9 Signing in with the dedicated test account...");
  primaryCookie = await signInPrimary();

  console.info("3/9 Running a complete production generation with forced SSE replay...");
  const created = await requiredRequest(
    "/api/projects",
    { cookie: primaryCookie, method: "POST", body: { prompt } },
    201
  );
  completedProjectId = created.projectId;
  projectRunIds.set(created.projectId, created.runId);
  const completed = await consumeRun(created.runId, {
    expectedTerminal: "run.completed",
    forceReconnect: true
  });
  const filesBody = await requiredRequest(`/api/projects/${completedProjectId}/files`, {
    cookie: primaryCookie
  });
  const files = await Promise.all(
    filesBody.files.map(async (file) => ({
      ...file,
      content: (
        await requiredRequest(
          `/api/projects/${completedProjectId}/files/content?path=${encodeURIComponent(file.path)}`,
          { cookie: primaryCookie }
        )
      ).content
    }))
  );
  const completionEvent = completed.events.findLast(({ type }) => type === "run.completed");
  const previewUrl = completionEvent?.payload?.previewUrl;
  validateFirstGenerationEvidence({
    projectId: completedProjectId,
    runId: created.runId,
    events: completed.events,
    files,
    previewUrl
  });
  const preview = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });

  console.info("4/9 Exercising a durable Preview job and source download...");
  const restart = await requiredRequest(
    `/api/projects/${completedProjectId}/runtime/restart`,
    { cookie: primaryCookie, method: "POST" },
    202
  );
  const runtimeJob = await waitForRuntimeJob(restart.runtimeJobId);
  assert.equal(
    runtimeJob.status,
    "completed",
    runtimeJob.errorMessage ?? "Preview restart failed."
  );
  const download = await request(`/api/projects/${completedProjectId}/download`, {
    cookie: primaryCookie
  });
  assert.equal(download.response.status, 200);
  const downloadBytes = (await download.response.arrayBuffer()).byteLength;

  console.info("5/9 Proving signed-out and cross-user denial across protected surfaces...");
  await createSecondaryAccount();
  const targets = accessRequests(
    completedProjectId,
    created.runId,
    restart.runtimeJobId,
    files[0].path
  );
  const secondaryAccess = await collectAccessMatrix(secondaryCookie, targets);
  const signedOutAccess = await collectAccessMatrix(undefined, targets);

  console.info("6/9 Cancelling an actively claimed disposable Run...");
  const cancellable = await requiredRequest(
    "/api/projects",
    {
      cookie: primaryCookie,
      method: "POST",
      body: { prompt: "创建一个可丢弃的简单计数器应用，用于取消验收。" }
    },
    201
  );
  cancelledProjectId = cancellable.projectId;
  projectRunIds.set(cancellable.projectId, cancellable.runId);
  let cancelRequested = false;
  const cancellationStream = await consumeRun(cancellable.runId, {
    expectedTerminal: "run.cancelled",
    onEvent: async (event) => {
      if (!cancelRequested && event.type === "run.planning") {
        cancelRequested = true;
        await requiredRequest(
          `/api/runs/${cancellable.runId}/cancel`,
          { cookie: primaryCookie, method: "POST" },
          202
        );
      }
    }
  });
  assert.equal(cancelRequested, true, "The disposable Run was never actively claimed.");
  const cancellationTerminal = cancellationStream.events.findLast(
    ({ type }) => type === "run.cancelled"
  );
  const filesBefore = await fileState(cancelledProjectId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const cancellationAfter = await requiredRequest(
    `/api/projects/${cancelledProjectId}/persistence`,
    { cookie: primaryCookie }
  );
  const filesAfter = await fileState(cancelledProjectId);
  const cancelledRun = cancellationAfter.runs.find(({ id }) => id === cancellable.runId);

  console.info("7/9 Verifying terminal queues and deterministic failure contracts...");
  const completedState = await requiredRequest(`/api/projects/${completedProjectId}/persistence`, {
    cookie: primaryCookie
  });
  const activeOrOrphanedRuntimeJobs = [completedState, cancellationAfter]
    .flatMap(({ runtimeJobs }) => runtimeJobs)
    .filter(({ status }) => ["queued", "processing"].includes(status)).length;

  console.info("8/9 Deleting both projects and waiting for Worker resource cleanup...");
  const completedProjectCleanup = await deleteAndWait(completedProjectId);
  projectRunIds.delete(completedProjectId);
  completedProjectId = undefined;
  const cancelledProjectCleanup = await deleteAndWait(cancelledProjectId);
  projectRunIds.delete(cancelledProjectId);
  cancelledProjectId = undefined;
  const dashboard = await request("/projects", { cookie: primaryCookie });
  const dashboardHtml = await dashboard.response.text();
  const projectsAbsentFromDashboard =
    !dashboardHtml.includes(created.projectId) && !dashboardHtml.includes(cancellable.projectId);

  console.info("9/9 Removing the ephemeral second Firebase account and signing the record...");
  await firebaseRequest("delete", { idToken: secondaryIdToken });
  secondaryIdToken = undefined;
  const evidence = validateProductionSmokeEvidence({
    verifiedAt: new Date().toISOString(),
    baseUrl,
    commitSha: process.env.RAILWAY_GIT_COMMIT_SHA?.trim(),
    projectId: created.projectId,
    runId: created.runId,
    completedStatus: completedState.runs.find(({ id }) => id === created.runId)?.status,
    previewHttpStatus: preview.status,
    fileCount: files.length,
    downloadBytes,
    runtimeJobStatus: runtimeJob.status,
    sse: {
      forcedReconnect: completed.forcedReconnect,
      eventIds: completed.eventIds
    },
    cancelledProjectId: cancellable.projectId,
    cancelledRunId: cancellable.runId,
    cancellation: {
      status: cancelledRun?.status,
      errorCode: cancelledRun?.errorCode,
      terminalEventCode: cancellationTerminal?.payload?.code,
      filesStableAfterTerminal: JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
      snapshotsAfterTerminal: cancellationAfter.snapshots.length
    },
    secondaryAccess,
    signedOutAccess,
    secondaryAccountDeleted: true,
    failureContracts: requiredFailureContracts,
    activeOrOrphanedRuntimeJobs,
    cleanup: {
      completedProjectCleanup,
      cancelledProjectCleanup,
      projectsAbsentFromDashboard
    }
  });
  console.info(formatProductionSmokeReport(evidence));
  console.info("Automated production smoke and fault acceptance passed.");
} catch (error) {
  console.error(`Acceptance runner failed before cleanup: ${boundedFailure(error)}`);
  throw error;
} finally {
  for (const projectId of [completedProjectId, cancelledProjectId].filter(Boolean)) {
    const runId = projectRunIds.get(projectId);
    if (runId)
      await request(`/api/runs/${runId}/cancel`, {
        cookie: primaryCookie,
        method: "POST"
      }).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const deleted = await request(`/api/projects/${projectId}`, {
        cookie: primaryCookie,
        method: "DELETE"
      }).catch(() => undefined);
      if (!deleted || deleted.response.status === 404) break;
      if (deleted.response.status === 202) {
        const cleanupJobId = deleted.body?.cleanupJobId;
        if (cleanupJobId) {
          while (Date.now() < deadline) {
            const cleanup = await request(`/api/resource-cleanups/${cleanupJobId}`, {
              cookie: primaryCookie
            }).catch(() => undefined);
            if (!cleanup || cleanup.body?.status === "completed") break;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (secondaryIdToken) {
    await firebaseRequest("delete", { idToken: secondaryIdToken }).catch(() => undefined);
  }
}
