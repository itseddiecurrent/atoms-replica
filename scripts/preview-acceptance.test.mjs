import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPreviewAcceptanceReport,
  validatePreviewAcceptanceEvidence
} from "./preview-acceptance.mjs";

function evidence(overrides = {}) {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    previewUrl: "https://5173-example.e2b.app",
    previewHttpStatus: 200,
    workspaceHttpStatus: 200,
    iframeLoaded: true,
    reloadRestored: true,
    interactions: {
      emptyRejected: true,
      firstAdded: true,
      secondDeleted: true,
      countAfterAdd: true,
      countAfterComplete: true,
      countAfterRestore: true,
      countAfterDelete: true
    },
    restartQueued: true,
    restartCompleted: true,
    restartedPreviewUrl: "https://5173-example.e2b.app",
    restartedPreviewHttpStatus: 200,
    browserSecurityErrors: 0,
    previewMutationRequests: 0,
    checkedAt: "2026-08-24T00:00:00.000Z",
    ...overrides
  };
}

test("accepts complete browser-level Preview evidence", () => {
  const accepted = validatePreviewAcceptanceEvidence(evidence());
  assert.equal(accepted.restartCompleted, true);
});

test("requires every Todo interaction and count transition", () => {
  assert.throws(
    () =>
      validatePreviewAcceptanceEvidence(
        evidence({ interactions: { ...evidence().interactions, countAfterRestore: false } })
      ),
    /Expected values to be strictly deep-equal/
  );
});

test("rejects an iframe security failure", () => {
  assert.throws(
    () => validatePreviewAcceptanceEvidence(evidence({ browserSecurityErrors: 1 })),
    /CSP or mixed-content/
  );
});

test("rejects remote Todo mutation traffic", () => {
  assert.throws(
    () => validatePreviewAcceptanceEvidence(evidence({ previewMutationRequests: 1 })),
    /remote mutation/
  );
});

test("formats a source-free, credential-free production record", () => {
  const report = formatPreviewAcceptanceReport(evidence());
  assert.match(report, /Preview Production Acceptance Record/);
  assert.match(report, /2 → 1 → 2 → 1/);
  assert.doesNotMatch(report, /password|cookie|src\/App|Preview acceptance alpha/i);
});
