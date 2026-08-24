import assert from "node:assert/strict";
import test from "node:test";

import {
  formatIncrementalAcceptanceReport,
  validateIncrementalAcceptanceEvidence
} from "./incremental-acceptance.mjs";

const ids = {
  projectId: "11111111-1111-4111-8111-111111111111",
  initialRunId: "22222222-2222-4222-8222-222222222222",
  followUpMessageId: "33333333-3333-4333-8333-333333333333",
  followUpRunId: "44444444-4444-4444-8444-444444444444",
  initialSnapshotId: "55555555-5555-4555-8555-555555555555",
  followUpSnapshotId: "66666666-6666-4666-8666-666666666666"
};

function evidence(overrides = {}) {
  return {
    ...ids,
    conversationPersisted: true,
    events: [
      { type: "run.queued", payload: {} },
      { type: "run.planning", payload: {} },
      { type: "plan.created", payload: {} },
      { type: "run.coding", payload: {} },
      { type: "tool.started", payload: { tool: "read_file", input: { path: "src/App.tsx" } } },
      { type: "file.updated", payload: { path: "src/App.tsx" } },
      { type: "run.validating", payload: {} },
      {
        type: "command.output",
        payload: { command: "npm install --no-audit --no-fund", exitCode: 0 }
      },
      { type: "command.output", payload: { command: "npm run build", exitCode: 0 } },
      { type: "preview.ready", payload: { url: "https://preview.e2b.app" } },
      { type: "run.completed", payload: { snapshotId: ids.followUpSnapshotId } }
    ],
    beforeFiles: [
      { path: "src/App.tsx", version: 1, contentHash: "old" },
      { path: "package.json", version: 1, contentHash: "same" }
    ],
    afterFiles: [
      { path: "src/App.tsx", version: 2, contentHash: "new" },
      { path: "package.json", version: 1, contentHash: "same" }
    ],
    previewUrl: "https://preview.e2b.app",
    previewHttpStatus: 200,
    browserSecurityErrors: 0,
    previewMutationRequests: 0,
    interactions: {
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
    },
    checkedAt: "2026-08-24T00:00:00.000Z",
    ...overrides
  };
}

test("accepts complete same-project incremental evidence", () => {
  const accepted = validateIncrementalAcceptanceEvidence(evidence());
  assert.deepEqual(
    accepted.changedFiles.map(({ path }) => path),
    ["src/App.tsx"]
  );
});

test("rejects a follow-up without an existing-file read", () => {
  assert.throws(
    () =>
      validateIncrementalAcceptanceEvidence(
        evidence({
          events: evidence().events.map((event) =>
            event.payload?.tool === "read_file"
              ? { type: "tool.started", payload: { tool: "write_file" } }
              : event
          )
        })
      ),
    /read an existing project file/
  );
});

test("rejects misleading version increments for unchanged content", () => {
  assert.throws(
    () =>
      validateIncrementalAcceptanceEvidence(
        evidence({
          afterFiles: [
            { path: "src/App.tsx", version: 2, contentHash: "new" },
            { path: "package.json", version: 2, contentHash: "same" }
          ]
        })
      ),
    /misleading new version/
  );
});

test("rejects unrelated file changes for the focused UI request", () => {
  assert.throws(
    () =>
      validateIncrementalAcceptanceEvidence(
        evidence({
          afterFiles: [
            { path: "src/App.tsx", version: 2, contentHash: "new" },
            { path: "package.json", version: 1, contentHash: "same" },
            { path: "README.md", version: 1, contentHash: "changed" }
          ]
        })
      ),
    /unrelated paths/
  );
});

test("rejects a missing filter behavior", () => {
  assert.throws(
    () =>
      validateIncrementalAcceptanceEvidence(
        evidence({
          interactions: { ...evidence().interactions, completedFilterPassed: false }
        })
      ),
    /deep-equal/
  );
});

test("formats a source-free and prompt-free production record", () => {
  const report = formatIncrementalAcceptanceReport(evidence());
  assert.match(report, /Incremental Modification Production Acceptance Record/);
  assert.match(report, /src\/App\.tsx.*v1 → v2/);
  assert.doesNotMatch(report, /把页面标题|contentHash|password|cookie|source/i);
});
