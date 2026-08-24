import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatFirstGenerationReport,
  productionBaseUrl,
  validateFirstGenerationEvidence
} from "./first-generation-evidence.mjs";

function validEvidence(overrides = {}) {
  const progress = [
    ["planning", 10],
    ["workspace", 20],
    ["coding", 30],
    ["validation", 65],
    ["preview", 88],
    ["saving", 95]
  ].map(([stage, percent]) => ({
    type: "stage.progress",
    payload: { stage, percent, title: String(stage) }
  }));
  return {
    projectId: "project-1",
    runId: "run-1",
    previewUrl: "https://5173-sandbox.e2b.app",
    files: [{ path: "src/App.tsx", content: "export default function App() {}" }],
    events: [
      { type: "run.queued", payload: {} },
      { type: "run.planning", payload: {} },
      progress[0],
      { type: "plan.created", payload: { summary: "Build Todo", steps: ["Build"] } },
      progress[1],
      { type: "run.coding", payload: {} },
      progress[2],
      { type: "tool.started", payload: { tool: "write_file" } },
      { type: "file.updated", payload: { path: "src/App.tsx" } },
      { type: "run.validating", payload: {} },
      progress[3],
      {
        type: "command.output",
        payload: { command: "npm install --no-audit --no-fund", output: "ok", exitCode: 0 }
      },
      {
        type: "command.output",
        payload: { command: "npm run build", output: "built", exitCode: 0 }
      },
      progress[4],
      { type: "preview.ready", payload: { url: "https://5173-sandbox.e2b.app" } },
      progress[5],
      {
        type: "run.completed",
        payload: {
          summary:
            "Generated and saved 8 project files. Validation passed: install and build. Preview is live."
        }
      }
    ],
    ...overrides
  };
}

describe("first production generation evidence", () => {
  it("accepts an ordered, traceable, persisted generation", () => {
    const result = validateFirstGenerationEvidence(validEvidence());
    assert.equal(result.terminalState, "completed");
    assert.equal(result.filesPersisted, 1);
    assert.deepEqual(
      result.validationCommands.map(({ exitCode }) => exitCode),
      [0, 0]
    );
  });

  it("rejects missing or out-of-order lifecycle events", () => {
    const input = validEvidence();
    input.events = input.events.filter((event) => event.type !== "run.coding");
    assert.throws(() => validateFirstGenerationEvidence(input), /missing run.coding/);
  });

  it("rejects vague completion text", () => {
    const input = validEvidence();
    input.events.at(-1).payload.summary = "Done.";
    assert.throws(() => validateFirstGenerationEvidence(input), /summary is too vague/);
  });

  it("rejects missing source and failed independent validation", () => {
    assert.throws(
      () => validateFirstGenerationEvidence(validEvidence({ files: [] })),
      /did not persist project files/
    );
    const input = validEvidence();
    input.events.find((event) => event.payload?.command === "npm run build").payload.exitCode = 1;
    assert.throws(() => validateFirstGenerationEvidence(input), /validation did not pass/);
  });

  it("formats a source-free, reproducible production record", () => {
    const report = formatFirstGenerationReport(validateFirstGenerationEvidence(validEvidence()));
    assert.match(report, /Project ID \| `project-1`/);
    assert.match(report, /src\/App\.tsx.*non-empty/);
    assert.doesNotMatch(report, /export default function/);
  });

  it("requires the public HTTPS production Web service", () => {
    assert.equal(
      productionBaseUrl("https://atoms.example.com/projects"),
      "https://atoms.example.com"
    );
    assert.throws(() => productionBaseUrl("http://localhost:3000"), /must use HTTPS/);
    assert.throws(
      () => productionBaseUrl("https://localhost:3000"),
      /must target the public production/
    );
  });
});
