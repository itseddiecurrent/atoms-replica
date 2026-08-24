import assert from "node:assert/strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEventAfter(events, type, after) {
  const index = events.findIndex((event, candidate) => candidate > after && event.type === type);
  if (index < 0) throw new Error(`Incremental evidence is missing ${type}.`);
  return index;
}

function validateFiles(beforeFiles, afterFiles) {
  assert.ok(Array.isArray(beforeFiles) && beforeFiles.length > 0, "Baseline files are required.");
  assert.ok(Array.isArray(afterFiles) && afterFiles.length > 0, "Updated files are required.");
  const before = new Map(beforeFiles.map((file) => [file.path, file]));
  const after = new Map(afterFiles.map((file) => [file.path, file]));
  const changed = [];
  const unchanged = [];

  for (const [path, current] of after) {
    const previous = before.get(path);
    if (!previous || previous.contentHash !== current.contentHash) {
      assert.ok(
        !previous || current.version > previous.version,
        `Changed file ${path} did not advance its version.`
      );
      changed.push({ path, beforeVersion: previous?.version ?? 0, afterVersion: current.version });
    } else {
      assert.equal(
        current.version,
        previous.version,
        `Unchanged file ${path} received a misleading new version.`
      );
      unchanged.push(path);
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path))
      changed.push({ path, beforeVersion: before.get(path).version, deleted: true });
  }
  assert.ok(changed.length > 0, "The follow-up did not change any persisted file.");
  assert.ok(unchanged.length > 0, "The follow-up did not preserve any unchanged file version.");
  assert.ok(
    changed.every(({ path }) => path === "index.html" || path === "src" || path.startsWith("src/")),
    `The focused UI request changed unrelated paths: ${changed.map(({ path }) => path).join(", ")}`
  );
  return { changed, unchanged };
}

export function validateIncrementalAcceptanceEvidence(evidence) {
  for (const [name, value] of [
    ["Project ID", evidence.projectId],
    ["Initial Run ID", evidence.initialRunId],
    ["Follow-up Message ID", evidence.followUpMessageId],
    ["Follow-up Run ID", evidence.followUpRunId],
    ["Initial Snapshot ID", evidence.initialSnapshotId],
    ["Follow-up Snapshot ID", evidence.followUpSnapshotId]
  ]) {
    assert.match(value ?? "", UUID_PATTERN, `${name} must be recorded.`);
  }
  assert.notEqual(
    evidence.initialRunId,
    evidence.followUpRunId,
    "Follow-up must create a new Run."
  );
  assert.notEqual(
    evidence.initialSnapshotId,
    evidence.followUpSnapshotId,
    "Follow-up must create a new Snapshot."
  );
  assert.equal(
    evidence.conversationPersisted,
    true,
    "Workspace did not preserve both user prompts."
  );
  assert.ok(Array.isArray(evidence.events) && evidence.events.length > 0);

  let cursor = -1;
  for (const type of [
    "run.queued",
    "run.planning",
    "plan.created",
    "run.coding",
    "tool.started",
    "run.validating",
    "preview.ready",
    "run.completed"
  ]) {
    cursor = requireEventAfter(evidence.events, type, cursor);
  }
  assert.ok(
    evidence.events.some(
      (event) => event.type === "tool.started" && event.payload?.tool === "read_file"
    ),
    "Coder did not read an existing project file before applying the follow-up."
  );

  const validationStart = evidence.events.findIndex((event) => event.type === "run.validating");
  const previewReady = evidence.events.findIndex((event) => event.type === "preview.ready");
  for (const command of ["npm install --no-audit --no-fund", "npm run build"]) {
    const result = evidence.events.find(
      (event, index) =>
        index > validationStart &&
        index < previewReady &&
        event.type === "command.output" &&
        event.payload?.command === command
    );
    assert.ok(result, `Incremental evidence is missing validation: ${command}.`);
    assert.equal(result.payload?.exitCode, 0, `${command} did not pass.`);
  }
  const completed = evidence.events.findLast((event) => event.type === "run.completed");
  assert.equal(
    completed?.payload?.snapshotId,
    evidence.followUpSnapshotId,
    "Completion event did not identify the follow-up Snapshot."
  );

  const fileChanges = validateFiles(evidence.beforeFiles, evidence.afterFiles);
  assert.match(evidence.previewUrl ?? "", /^https:\/\//, "Updated Preview must use HTTPS.");
  assert.equal(evidence.previewHttpStatus, 200, "Updated Preview must return HTTP 200.");
  assert.equal(evidence.browserSecurityErrors, 0, "Browser reported a Preview security error.");
  assert.equal(
    evidence.previewMutationRequests,
    0,
    "Todo regression checks sent an unexpected remote mutation request."
  );
  assert.deepEqual(evidence.interactions, {
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
  });

  return {
    ...evidence,
    checkedAt: evidence.checkedAt ?? new Date().toISOString(),
    changedFiles: fileChanges.changed,
    unchangedFileCount: fileChanges.unchanged.length
  };
}

export function formatIncrementalAcceptanceReport(evidence) {
  const accepted = validateIncrementalAcceptanceEvidence(evidence);
  const versions = accepted.changedFiles
    .map((file) =>
      file.deleted
        ? `\`${file.path}\` v${file.beforeVersion} → deleted`
        : `\`${file.path}\` v${file.beforeVersion} → v${file.afterVersion}`
    )
    .join("; ");
  return [
    "## Incremental Modification Production Acceptance Record",
    "",
    `- Checked at: ${accepted.checkedAt}`,
    `- Project ID: ${accepted.projectId} (unchanged across both Runs)`,
    `- Initial Run ID: ${accepted.initialRunId}`,
    `- Follow-up Message ID: ${accepted.followUpMessageId}`,
    `- Follow-up Run ID: ${accepted.followUpRunId}`,
    `- Snapshot continuity: ${accepted.initialSnapshotId} → ${accepted.followUpSnapshotId}`,
    `- Changed file versions: ${versions}`,
    `- Unchanged file versions preserved: ${accepted.unchangedFileCount}`,
    "- Existing-file context: Coder read persisted project files before editing",
    "- Independent validation: dependency install and production build exited 0",
    `- Updated Preview: HTTP ${accepted.previewHttpStatus} (HTTPS)`,
    "- New UI: Focus Todo title and All/Active/Completed filters passed",
    "- Regression check: empty validation, add, complete, restore, delete, and remaining count passed",
    "- Conversation continuity: both user prompts restored in the same Workspace",
    "- Browser security errors: 0; Preview mutation requests: 0"
  ].join("\n");
}
