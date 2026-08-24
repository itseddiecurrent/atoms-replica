function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function firstIndexAfter(events, type, after) {
  const index = events.findIndex((event, candidate) => candidate > after && event.type === type);
  if (index < 0) throw new Error(`Initial generation evidence is missing ${type}.`);
  return index;
}

export function productionBaseUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("E2E_BASE_URL must use HTTPS production access.");
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  )
    throw new Error("E2E_BASE_URL must target the public production Web service.");
  return url.origin;
}

export function validateFirstGenerationEvidence({ projectId, runId, events, files, previewUrl }) {
  requireValue(projectId, "Initial generation evidence requires a Project ID.");
  requireValue(runId, "Initial generation evidence requires a Run ID.");
  requireValue(previewUrl, "Initial generation did not publish a Preview URL.");
  if (!Array.isArray(events) || !events.length)
    throw new Error("Initial generation did not publish durable Run events.");

  let cursor = -1;
  for (const type of [
    "run.queued",
    "run.planning",
    "plan.created",
    "run.coding",
    "tool.started",
    "file.updated",
    "run.validating",
    "preview.ready",
    "run.completed"
  ]) {
    cursor = firstIndexAfter(events, type, cursor);
  }

  const progress = events.filter((event) => event.type === "stage.progress");
  for (const stage of ["planning", "workspace", "coding", "validation", "preview", "saving"]) {
    if (!progress.some((event) => event.payload?.stage === stage))
      throw new Error(`Initial generation progress is missing the ${stage} stage.`);
  }
  const percentages = progress.map((event) => event.payload?.percent).filter(Number.isFinite);
  if (percentages.some((percent, index) => index > 0 && percent < percentages[index - 1]))
    throw new Error("Initial generation progress percentages must be monotonic.");

  const validationStartedAt = events.findIndex((event) => event.type === "run.validating");
  const previewReadyAt = events.findIndex((event) => event.type === "preview.ready");
  const commands = events.filter(
    (event, index) =>
      event.type === "command.output" && index > validationStartedAt && index < previewReadyAt
  );
  for (const command of ["npm install --no-audit --no-fund", "npm run build"]) {
    const result = commands.find((event) => event.payload?.command === command);
    if (!result) throw new Error(`Initial generation evidence is missing validation: ${command}.`);
    if (result.payload?.exitCode !== 0)
      throw new Error(`Initial generation validation did not pass: ${command}.`);
  }

  const completed = events.findLast((event) => event.type === "run.completed");
  const summary = completed?.payload?.summary;
  if (
    typeof summary !== "string" ||
    !summary.includes("Generated and saved") ||
    !summary.includes("Validation passed") ||
    !summary.includes("Preview is live")
  )
    throw new Error("Initial generation completion summary is too vague for production evidence.");

  if (!Array.isArray(files) || files.length === 0)
    throw new Error("Initial generation did not persist project files.");
  const app = files.find((file) => file.path === "src/App.tsx");
  if (!app || typeof app.content !== "string" || !app.content.trim())
    throw new Error("Initial generation did not persist non-empty src/App.tsx source.");

  const preview = new URL(previewUrl);
  if (preview.protocol !== "https:") throw new Error("Initial generation Preview must use HTTPS.");

  return {
    verifiedAt: new Date().toISOString(),
    projectId,
    runId,
    terminalState: "completed",
    eventCount: events.length,
    progressStages: progress.map((event) => event.payload.stage),
    filesPersisted: files.length,
    appFile: "src/App.tsx",
    validationCommands: commands.map((event) => ({
      command: event.payload.command,
      exitCode: event.payload.exitCode
    })),
    previewUrl,
    completionSummary: summary
  };
}

export function formatFirstGenerationReport(result) {
  return `# First Production Generation Record

| Field | Evidence |
| --- | --- |
| Verified at | ${result.verifiedAt} |
| Project ID | \`${result.projectId}\` |
| Run ID | \`${result.runId}\` |
| Terminal state | ${result.terminalState} |
| Durable Run events | ${result.eventCount} |
| Progress stages | ${result.progressStages.join(" → ")} |
| Persisted files | ${result.filesPersisted} |
| IDE source check | \`${result.appFile}\` is non-empty |
| Independent validation | ${result.validationCommands.map(({ command, exitCode }) => `\`${command}\` exit ${exitCode}`).join("; ")} |
| HTTPS Preview | ${result.previewUrl} |
| Completion summary | ${result.completionSummary} |
`;
}
