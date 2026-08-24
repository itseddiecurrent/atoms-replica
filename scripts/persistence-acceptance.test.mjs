import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPersistenceAcceptanceReport,
  isUnsafeDownloadPath,
  readStoredZip,
  validatePersistenceAcceptanceEvidence
} from "./persistence-acceptance.mjs";

const ids = {
  projectId: "11111111-1111-4111-8111-111111111111",
  initialRunId: "22222222-2222-4222-8222-222222222222",
  followUpRunId: "33333333-3333-4333-8333-333333333333",
  initialSnapshotId: "44444444-4444-4444-8444-444444444444",
  followUpSnapshotId: "55555555-5555-4555-8555-555555555555",
  restoreJobId: "66666666-6666-4666-8666-666666666666",
  ideJobId: "77777777-7777-4777-8777-777777777777"
};
const interactions = {
  titleVisible: true,
  filtersVisible: true,
  emptyRejected: true,
  twoAdded: true,
  completePassed: true,
  activeFilterPassed: true,
  completedFilterPassed: true,
  allFilterPassed: true,
  restorePassed: true,
  deletePassed: true,
  countSequencePassed: true
};
const workspace = {
  projectVisible: true,
  conversationVisible: true,
  planVisible: true,
  finalStatusVisible: true,
  fileTreeVisible: true,
  previewVisible: true,
  sourceRestored: true,
  fileVersionVisible: true
};

function graph(sandboxId, previewUrl, appVersion, jobs = []) {
  return {
    project: {
      id: ids.projectId,
      status: "running",
      previewUrl,
      sandboxId,
      sandboxExpiresAt: "2026-08-24T01:00:00.000Z",
      latestSnapshotId: ids.followUpSnapshotId
    },
    messages: [
      { id: "m1", role: "user", runId: ids.initialRunId },
      { id: "m2", role: "assistant", runId: ids.initialRunId },
      { id: "m3", role: "user", runId: ids.followUpRunId },
      { id: "m4", role: "assistant", runId: ids.followUpRunId }
    ],
    runs: [
      { id: ids.initialRunId, triggerMessageId: "m1", status: "completed", hasPlan: true },
      { id: ids.followUpRunId, triggerMessageId: "m3", status: "completed", hasPlan: true }
    ],
    files: [
      { path: "package.json", version: 1 },
      { path: "src/App.tsx", version: 6 },
      { path: "src/styles.css", version: appVersion }
    ],
    snapshots: [
      { id: ids.initialSnapshotId, runId: ids.initialRunId },
      { id: ids.followUpSnapshotId, runId: ids.followUpRunId }
    ],
    runtimeJobs: jobs
  };
}

function evidence(overrides = {}) {
  return {
    ...ids,
    browser: {
      initial: workspace,
      reloaded: workspace,
      relogged: workspace,
      dashboardBeforeLogout: true,
      dashboardAfterLogin: true,
      signedOut: true,
      signedIn: true
    },
    beforeExpiry: graph("oldsandbox", "https://old.e2b.app", 6),
    afterRestore: graph("newsandbox", "https://new.e2b.app", 6, [
      { id: ids.restoreJobId, type: "restart_preview", status: "completed" }
    ]),
    afterIdeSave: graph("newsandbox", "https://new.e2b.app", 7, [
      { id: ids.restoreJobId, type: "restart_preview", status: "completed" },
      { id: ids.ideJobId, type: "sync_file", status: "completed" }
    ]),
    restore: {
      runtimeJobId: ids.restoreJobId,
      restoredByUi: true,
      previewHttpStatus: 200,
      incrementalResultVisible: true
    },
    ide: {
      runtimeJobId: ids.ideJobId,
      markerVisible: true,
      browserSecurityErrors: 0,
      previewMutationRequests: 0,
      interactions
    },
    download: {
      filesMatchServer: true,
      fileCount: 3,
      unsafePaths: [],
      installExitCode: 0,
      buildExitCode: 0,
      testExitCode: 0,
      serverHttpStatus: 200,
      markerVisible: true,
      interactions
    },
    expectedInteractions: interactions,
    checkedAt: "2026-08-24T00:00:00.000Z",
    ...overrides
  };
}

test("accepts complete persistence, recovery, IDE, and download evidence", () => {
  assert.equal(validatePersistenceAcceptanceEvidence(evidence()).download.fileCount, 3);
});

test("rejects a reused Sandbox after expiry", () => {
  assert.throws(
    () =>
      validatePersistenceAcceptanceEvidence(
        evidence({ afterRestore: graph("oldsandbox", "https://new.e2b.app", 6) })
      ),
    /replaced by a new Sandbox/
  );
});

test("rejects a missing or orphaned persistence relation", () => {
  const broken = graph("newsandbox", "https://new.e2b.app", 7, [
    { id: ids.ideJobId, type: "sync_file", status: "completed" }
  ]);
  broken.snapshots[1].runId = "88888888-8888-4888-8888-888888888888";
  assert.throws(
    () => validatePersistenceAcceptanceEvidence(evidence({ afterIdeSave: broken })),
    /snapshots/
  );
});

test("rejects unsafe downloaded paths", () => {
  for (const path of [".env", ".env.local", "node_modules/a", "dist/a", ".git/config", "../x"])
    assert.equal(isUnsafeDownloadPath(path), true);
  assert.equal(isUnsafeDownloadPath("src/App.tsx"), false);
});

test("reads the stored ZIP format used by project downloads", () => {
  const name = new TextEncoder().encode("src/App.tsx");
  const content = new TextEncoder().encode("app");
  const bytes = new Uint8Array(30 + name.length + content.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, content.length, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  bytes.set(content, 30 + name.length);
  assert.deepEqual(readStoredZip(bytes), [{ path: "src/App.tsx", content: "app" }]);
});

test("formats a credential-free persistence record", () => {
  const report = formatPersistenceAcceptanceReport(evidence());
  assert.match(report, /Persistence, Recovery, and Download Production Acceptance Record/);
  assert.match(report, /oldsandbox → newsandbox/);
  assert.doesNotMatch(report, /password|cookie|source content|storage key/i);
});
