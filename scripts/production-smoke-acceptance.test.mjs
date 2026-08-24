import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProductionSmokeReport,
  protectedSurfaces,
  requiredFailureContracts,
  validateProductionSmokeEvidence
} from "./production-smoke-acceptance.mjs";

function evidence() {
  return {
    verifiedAt: "2026-08-24T00:00:00.000Z",
    baseUrl: "https://atom.example.com",
    commitSha: "a".repeat(40),
    projectId: "project-1",
    runId: "run-1",
    completedStatus: "completed",
    previewHttpStatus: 200,
    fileCount: 13,
    downloadBytes: 1024,
    runtimeJobStatus: "completed",
    sse: { forcedReconnect: true, eventIds: [1, 2, 5, 9] },
    cancelledProjectId: "project-2",
    cancelledRunId: "run-2",
    cancellation: {
      status: "cancelled",
      errorCode: "RUN_CANCELLED",
      terminalEventCode: "RUN_CANCELLED",
      filesStableAfterTerminal: true,
      snapshotsAfterTerminal: 0
    },
    secondaryAccess: Object.fromEntries(protectedSurfaces.map((surface) => [surface, 404])),
    signedOutAccess: Object.fromEntries(protectedSurfaces.map((surface) => [surface, 401])),
    secondaryAccountDeleted: true,
    failureContracts: requiredFailureContracts,
    activeOrOrphanedRuntimeJobs: 0,
    cleanup: {
      completedProjectCleanup: "completed",
      cancelledProjectCleanup: "completed",
      projectsAbsentFromDashboard: true
    }
  };
}

test("accepts complete production smoke and fault evidence", () => {
  assert.equal(validateProductionSmokeEvidence(evidence()).fileCount, 13);
});

test("rejects duplicate SSE replay events", () => {
  const value = evidence();
  value.sse.eventIds = [1, 2, 2, 3];
  assert.throws(() => validateProductionSmokeEvidence(value), /duplicated/);
});

test("rejects cancellation without its durable error classification", () => {
  const value = evidence();
  value.cancellation.errorCode = null;
  assert.throws(() => validateProductionSmokeEvidence(value), /RUN_CANCELLED/);
});

test("rejects one cross-user surface leaking existence", () => {
  const value = evidence();
  value.secondaryAccess.download = 200;
  assert.throws(() => validateProductionSmokeEvidence(value), /download returned 200/);
});

test("rejects a missing limit or build failure contract", () => {
  const value = evidence();
  value.failureContracts = value.failureContracts.slice(1);
  assert.throws(() => validateProductionSmokeEvidence(value), /failure classification/);
});

test("formats a credential-free acceptance record", () => {
  const report = formatProductionSmokeReport(evidence());
  assert.match(report, /Automated Production Smoke and Fault Acceptance Record/);
  assert.match(report, /RUN_CANCELLED/);
  assert.doesNotMatch(report, /super-secret|session-cookie-value|const privateSource/);
});
