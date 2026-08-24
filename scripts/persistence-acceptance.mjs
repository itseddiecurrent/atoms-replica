import assert from "node:assert/strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsafeSegments = new Set(["node_modules", ".git", "dist", ".vite", "coverage"]);

export function readStoredZip(zip) {
  const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true);
    assert.equal(compression, 0, "Downloaded ZIP must use the supported stored-file format.");
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const contentOffset = offset + 30 + nameLength + extraLength;
    const path = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    assert.ok(contentOffset + size <= bytes.length, "Downloaded ZIP is truncated.");
    files.push({
      path,
      content: decoder.decode(bytes.slice(contentOffset, contentOffset + size))
    });
    offset = contentOffset + size;
  }
  assert.ok(files.length > 0, "Downloaded ZIP contains no project files.");
  return files;
}

export function isUnsafeDownloadPath(path) {
  const segments = path.split("/");
  return (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        unsafeSegments.has(segment) ||
        segment === ".env" ||
        segment.startsWith(".env.")
    )
  );
}

function assertWorkspaceState(state, label) {
  assert.deepEqual(
    state,
    {
      projectVisible: true,
      conversationVisible: true,
      planVisible: true,
      finalStatusVisible: true,
      fileTreeVisible: true,
      previewVisible: true,
      sourceRestored: true,
      fileVersionVisible: true
    },
    `${label} did not restore the complete Workspace state.`
  );
}

export function resolvePersistenceCheckpoint(state) {
  assert.match(state?.project?.id ?? "", UUID_PATTERN, "Checkpoint Project ID must be recorded.");
  assert.equal(state.project.status, "running", "Checkpoint Project must be Running.");
  assert.match(state.project.previewUrl ?? "", /^https:\/\//, "Checkpoint Preview URL is missing.");
  assert.match(state.project.sandboxId ?? "", /^[a-z0-9]+$/i, "Checkpoint Sandbox ID is missing.");
  assert.ok(
    Number.isFinite(new Date(state.project.sandboxExpiresAt).getTime()),
    "Checkpoint Sandbox expiry is invalid."
  );
  assert.equal(state.runs.length, 2, "Checkpoint must contain exactly two Agent Runs.");
  assert.ok(
    state.runs.every((run) => run.status === "completed" && run.hasPlan),
    "Checkpoint Runs must be completed with durable plans."
  );
  assert.equal(
    state.messages.length,
    4,
    "Checkpoint must contain both user and assistant messages."
  );
  assert.equal(state.snapshots.length, 2, "Checkpoint must contain both Run Snapshots.");
  assert.ok(state.files.length > 0, "Checkpoint must contain Project Files.");
  assert.ok(state.files.every((file) => file.version > 0));

  const [initialRun, followUpRun] = state.runs;
  const runIds = new Set(state.runs.map((run) => run.id));
  const messageIds = new Set(state.messages.map((message) => message.id));
  assert.equal(runIds.size, 2, "Checkpoint Run IDs must be unique.");
  assert.ok(
    state.runs.every((run) => messageIds.has(run.triggerMessageId)),
    "Checkpoint Runs must reference their durable trigger Messages."
  );
  assert.ok(
    state.messages.every((message) => message.runId && runIds.has(message.runId)),
    "Checkpoint Messages must reference one of the two Runs."
  );
  const initialSnapshot = state.snapshots.find((snapshot) => snapshot.runId === initialRun.id);
  const followUpSnapshot = state.snapshots.find((snapshot) => snapshot.runId === followUpRun.id);
  assert.ok(initialSnapshot, "Checkpoint is missing the initial Run Snapshot.");
  assert.ok(followUpSnapshot, "Checkpoint is missing the follow-up Run Snapshot.");
  assert.equal(
    state.project.latestSnapshotId,
    followUpSnapshot.id,
    "Checkpoint latest Snapshot pointer is invalid."
  );
  assert.ok(followUpRun.planSummary, "Checkpoint follow-up plan summary is missing.");

  return {
    projectId: state.project.id,
    previewUrl: state.project.previewUrl,
    sandboxExpiresAt: state.project.sandboxExpiresAt,
    initialRunId: initialRun.id,
    followUpRunId: followUpRun.id,
    initialSnapshotId: initialSnapshot.id,
    followUpSnapshotId: followUpSnapshot.id,
    followUpPlanSummary: followUpRun.planSummary
  };
}

export function formatPersistenceCheckpointReport(state) {
  const checkpoint = resolvePersistenceCheckpoint(state);
  return [
    "## Persistence Acceptance Checkpoint",
    "",
    `- Project ID: ${checkpoint.projectId}`,
    `- Run history: ${checkpoint.initialRunId} → ${checkpoint.followUpRunId}`,
    `- Snapshot history: ${checkpoint.initialSnapshotId} → ${checkpoint.followUpSnapshotId}`,
    `- Original Sandbox expiry: ${new Date(checkpoint.sandboxExpiresAt).toISOString()}`,
    "- Reload, logout/login, Dashboard recovery, conversation, plan, files, versions, and Preview URL passed",
    "- Next deployment: set E2E_PERSISTENCE_PHASE=resume and E2E_PERSISTENCE_PROJECT_ID to the Project ID above"
  ].join("\n");
}

function assertDataGraph(state, expected) {
  assert.equal(state.project.id, expected.projectId);
  assert.equal(state.project.status, "running");
  assert.match(state.project.previewUrl ?? "", /^https:\/\//);
  assert.match(state.project.sandboxId ?? "", /^[a-z0-9]+$/i);
  assert.ok(new Date(state.project.sandboxExpiresAt).getTime() > 0);
  assert.equal(state.project.latestSnapshotId, expected.followUpSnapshotId);

  const runIds = new Set(state.runs.map((run) => run.id));
  const messageIds = new Set(state.messages.map((message) => message.id));
  const snapshotIds = new Set(state.snapshots.map((snapshot) => snapshot.id));
  assert.deepEqual(
    [...runIds].sort(),
    [expected.initialRunId, expected.followUpRunId].sort(),
    "Persistence graph must contain exactly both Agent Runs."
  );
  assert.ok(state.runs.every((run) => run.status === "completed" && run.hasPlan));
  assert.ok(state.runs.every((run) => messageIds.has(run.triggerMessageId)));
  assert.equal(state.messages.length, 4, "Both user and assistant messages must be durable.");
  assert.ok(state.messages.every((message) => message.runId && runIds.has(message.runId)));
  assert.ok(snapshotIds.has(expected.initialSnapshotId));
  assert.ok(snapshotIds.has(expected.followUpSnapshotId));
  assert.ok(state.snapshots.every((snapshot) => runIds.has(snapshot.runId)));
  assert.ok(snapshotIds.has(state.project.latestSnapshotId));
  assert.ok(state.files.length > 0);
  assert.ok(state.files.every((file) => file.version > 0));
}

export function validatePersistenceAcceptanceEvidence(evidence) {
  for (const [label, value] of [
    ["Project ID", evidence.projectId],
    ["Initial Run ID", evidence.initialRunId],
    ["Follow-up Run ID", evidence.followUpRunId],
    ["Initial Snapshot ID", evidence.initialSnapshotId],
    ["Follow-up Snapshot ID", evidence.followUpSnapshotId],
    ["Restore Runtime Job ID", evidence.restore.runtimeJobId],
    ["IDE Runtime Job ID", evidence.ide.runtimeJobId]
  ])
    assert.match(value ?? "", UUID_PATTERN, `${label} must be recorded.`);

  assertWorkspaceState(evidence.browser.initial, "Initial load");
  assertWorkspaceState(evidence.browser.reloaded, "Page reload");
  assertWorkspaceState(evidence.browser.relogged, "Re-login");
  assert.equal(
    evidence.browser.dashboardBeforeLogout,
    true,
    "Dashboard must contain the Project before logout."
  );
  assert.equal(
    evidence.browser.dashboardAfterLogin,
    true,
    "Dashboard must restore the Project after login."
  );
  assert.equal(evidence.browser.signedOut, true, "Dedicated account must sign out.");
  assert.equal(evidence.browser.signedIn, true, "Dedicated account must sign back in.");

  const expected = {
    projectId: evidence.projectId,
    initialRunId: evidence.initialRunId,
    followUpRunId: evidence.followUpRunId,
    initialSnapshotId: evidence.initialSnapshotId,
    followUpSnapshotId: evidence.followUpSnapshotId
  };
  assertDataGraph(evidence.beforeExpiry, expected);
  assertDataGraph(evidence.afterRestore, expected);
  assertDataGraph(evidence.afterIdeSave, expected);
  assert.notEqual(
    evidence.beforeExpiry.project.sandboxId,
    evidence.afterRestore.project.sandboxId,
    "Expired Sandbox must be replaced by a new Sandbox."
  );
  assert.notEqual(
    evidence.beforeExpiry.project.previewUrl,
    evidence.afterRestore.project.previewUrl,
    "Restored Sandbox must publish a new Preview URL."
  );
  assert.equal(evidence.restore.restoredByUi, true);
  assert.equal(evidence.restore.previewHttpStatus, 200);
  assert.equal(evidence.restore.incrementalResultVisible, true);

  const beforeEditedFile = evidence.afterRestore.files.find(
    (file) => file.path === "src/styles.css"
  );
  const finalEditedFile = evidence.afterIdeSave.files.find(
    (file) => file.path === "src/styles.css"
  );
  assert.ok(beforeEditedFile && finalEditedFile);
  assert.equal(
    finalEditedFile.version,
    beforeEditedFile.version + 1,
    "IDE save must create one new file version."
  );
  const ideJob = evidence.afterIdeSave.runtimeJobs.find(
    (job) => job.id === evidence.ide.runtimeJobId
  );
  assert.deepEqual(
    ideJob,
    { id: evidence.ide.runtimeJobId, type: "sync_file", status: "completed" },
    "IDE Runtime Job must reach a durable completed state."
  );
  assert.equal(evidence.ide.markerVisible, true);
  assert.equal(evidence.ide.browserSecurityErrors, 0);
  assert.equal(evidence.ide.previewMutationRequests, 0);
  assert.deepEqual(evidence.ide.interactions, evidence.expectedInteractions);

  assert.equal(evidence.download.filesMatchServer, true);
  assert.equal(evidence.download.fileCount, evidence.afterIdeSave.files.length);
  assert.deepEqual(evidence.download.unsafePaths, []);
  assert.equal(evidence.download.installExitCode, 0);
  assert.equal(evidence.download.buildExitCode, 0);
  assert.equal(evidence.download.testExitCode, 0);
  assert.equal(evidence.download.serverHttpStatus, 200);
  assert.equal(evidence.download.markerVisible, true);
  assert.deepEqual(evidence.download.interactions, evidence.expectedInteractions);
  assert.ok(
    evidence.afterIdeSave.runtimeJobs.every((job) => ["completed", "failed"].includes(job.status)),
    "Persistence graph contains an active or orphaned Runtime Job."
  );

  return { ...evidence, checkedAt: evidence.checkedAt ?? new Date().toISOString() };
}

export function formatPersistenceAcceptanceReport(evidence) {
  const accepted = validatePersistenceAcceptanceEvidence(evidence);
  return [
    "## Persistence, Recovery, and Download Production Acceptance Record",
    "",
    `- Checked at: ${accepted.checkedAt}`,
    `- Project ID: ${accepted.projectId}`,
    `- Run history: ${accepted.initialRunId} → ${accepted.followUpRunId} (both completed with plans)`,
    `- Snapshot history: ${accepted.initialSnapshotId} → ${accepted.followUpSnapshotId} (latest pointer valid)`,
    "- Page reload and dedicated-account logout/login: Dashboard, conversation, plan, final status, file tree, source, versions, and Preview URL restored",
    `- Sandbox recovery: ${accepted.beforeExpiry.project.sandboxId} → ${accepted.afterRestore.project.sandboxId}`,
    `- Restored Preview: HTTP ${accepted.restore.previewHttpStatus}; incremental title and filters preserved`,
    `- IDE save: src/styles.css v${accepted.afterRestore.files.find((file) => file.path === "src/styles.css").version} → v${accepted.afterIdeSave.files.find((file) => file.path === "src/styles.css").version}; Runtime Job completed; visible Preview updated`,
    `- Download ZIP: ${accepted.download.fileCount} files matched the server; unsafe paths 0`,
    "- Clean download: npm install, production build, tests, independent server, and Todo browser behavior passed",
    "- Data consistency: Messages, Runs, Project Files, Snapshots, latest pointer, and Runtime Jobs have no missing references or active orphan state"
  ].join("\n");
}
