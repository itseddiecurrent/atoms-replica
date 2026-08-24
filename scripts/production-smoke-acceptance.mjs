import assert from "node:assert/strict";

const protectedSurfaces = [
  "project",
  "files",
  "fileContent",
  "download",
  "persistence",
  "messages",
  "events",
  "cancel",
  "runtimeRestart",
  "runtimeJob",
  "delete"
];

export const requiredFailureContracts = [
  "token:AI_LIMIT",
  "turns:AI_LIMIT",
  "tool_calls:AI_LIMIT",
  "duration:RUN_TIMEOUT",
  "build:BUILD_FAILED"
];

function assertAccessMatrix(matrix, expected, label) {
  for (const surface of protectedSurfaces) {
    const status = matrix?.[surface];
    assert.ok(expected.includes(status), `${label} ${surface} returned ${String(status)}.`);
  }
}

export function validateProductionSmokeEvidence(evidence) {
  assert.match(
    evidence?.baseUrl ?? "",
    /^https:\/\//,
    "Smoke evidence requires a public HTTPS URL."
  );
  assert.ok(evidence?.projectId, "Smoke evidence requires the completed Project ID.");
  assert.ok(evidence?.runId, "Smoke evidence requires the completed Run ID.");
  assert.equal(evidence?.completedStatus, "completed");
  assert.equal(evidence?.previewHttpStatus, 200);
  assert.ok(evidence?.fileCount > 0, "The completed smoke project did not persist files.");
  assert.ok(evidence?.downloadBytes > 4, "The completed smoke project did not download a ZIP.");
  assert.equal(evidence?.runtimeJobStatus, "completed");

  const ids = evidence?.sse?.eventIds ?? [];
  assert.ok(ids.length > 1, "SSE evidence did not contain enough durable events.");
  assert.equal(evidence?.sse?.forcedReconnect, true);
  assert.equal(new Set(ids).size, ids.length, "SSE replay duplicated an event.");
  assert.ok(
    ids.every((id, index) => index === 0 || id > ids[index - 1]),
    "SSE event IDs regressed."
  );

  assert.ok(evidence?.cancelledProjectId, "Cancellation evidence requires a Project ID.");
  assert.ok(evidence?.cancelledRunId, "Cancellation evidence requires a Run ID.");
  assert.equal(evidence?.cancellation?.status, "cancelled");
  assert.equal(evidence?.cancellation?.errorCode, "RUN_CANCELLED");
  assert.equal(evidence?.cancellation?.terminalEventCode, "RUN_CANCELLED");
  assert.equal(evidence?.cancellation?.filesStableAfterTerminal, true);
  assert.equal(evidence?.cancellation?.snapshotsAfterTerminal, 0);

  assertAccessMatrix(evidence?.secondaryAccess, [404], "Secondary-account");
  assertAccessMatrix(evidence?.signedOutAccess, [401, 302, 303, 307, 308], "Signed-out");
  assert.equal(evidence?.secondaryAccountDeleted, true);

  assert.deepEqual(
    [...(evidence?.failureContracts ?? [])].sort(),
    [...requiredFailureContracts].sort(),
    "The release gate did not prove every required failure classification."
  );
  assert.equal(evidence?.activeOrOrphanedRuntimeJobs, 0);
  assert.equal(evidence?.cleanup.completedProjectCleanup, "completed");
  assert.equal(evidence?.cleanup.cancelledProjectCleanup, "completed");
  assert.equal(evidence?.cleanup.projectsAbsentFromDashboard, true);
  return evidence;
}

export function formatProductionSmokeReport(evidence) {
  const accepted = validateProductionSmokeEvidence(evidence);
  return [
    "# Automated Production Smoke and Fault Acceptance Record",
    "",
    `- Verified at: ${accepted.verifiedAt}`,
    `- Public URL: ${accepted.baseUrl}`,
    `- Acceptance commit: ${accepted.commitSha ?? "unavailable"}`,
    `- Completed Project / Run: ${accepted.projectId} / ${accepted.runId}`,
    `- SSE replay: ${accepted.sse.eventIds.length} strictly increasing unique events across a forced reconnect`,
    `- Preview / files / download: HTTP ${accepted.previewHttpStatus}; ${accepted.fileCount} files; ${accepted.downloadBytes} ZIP bytes`,
    `- Cancellation Project / Run: ${accepted.cancelledProjectId} / ${accepted.cancelledRunId}`,
    "- Cancellation terminal: cancelled / RUN_CANCELLED; files stable; no Snapshot created",
    `- Authorization: ${protectedSurfaces.length} surfaces denied to both a second account and signed-out requests`,
    `- Failure contracts: ${accepted.failureContracts.join(", ")}`,
    "- Queue audit: no active or orphaned Runtime Jobs in either acceptance project",
    "- Cleanup: both durable Worker cleanup jobs completed; both projects absent from Dashboard",
    "- Ephemeral second Firebase test account: deleted",
    "",
    "No password, Session Cookie, API key, Prompt body, generated source, Sandbox ID, or Snapshot key is included in this record."
  ].join("\n");
}

export { protectedSurfaces };
