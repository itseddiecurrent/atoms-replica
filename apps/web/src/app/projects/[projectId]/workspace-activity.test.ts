import { describe, expect, it } from "vitest";

import {
  activityFromRunEvent,
  initialProgressForStatus,
  progressFromRunEvent
} from "./workspace-activity";

describe("workspace generation activity", () => {
  it("turns file and command events into specific, useful messages", () => {
    expect(
      activityFromRunEvent({
        eventId: 1,
        type: "file.updated",
        payload: { path: "src/App.tsx" }
      })
    ).toMatchObject({ title: "Updated file", detail: "src/App.tsx", tone: "success" });
    expect(
      activityFromRunEvent({
        eventId: 2,
        type: "command.output",
        payload: { command: "npm run build", exitCode: 0, output: "built in 1.2s" }
      })
    ).toMatchObject({
      title: "Command passed",
      detail: "$ npm run build · exit 0 · built in 1.2s"
    });
  });

  it("does not expose file contents returned by completed tools", () => {
    const activity = activityFromRunEvent({
      eventId: 3,
      type: "tool.completed",
      payload: { tool: "read_file", success: true, output: "private source contents" }
    });
    expect(activity).toMatchObject({ title: "Reading file completed" });
    expect(JSON.stringify(activity)).not.toContain("private source contents");
  });

  it("tracks monotonic milestone progress through completion", () => {
    const coding = progressFromRunEvent(initialProgressForStatus("queued"), {
      eventId: 4,
      type: "stage.progress",
      payload: { stage: "coding", percent: 30, title: "Generating project code" }
    });
    const stale = progressFromRunEvent(coding, {
      eventId: 5,
      type: "run.planning",
      payload: {}
    });
    const completed = progressFromRunEvent(stale, {
      eventId: 6,
      type: "run.completed",
      payload: { summary: "Generated and validated 8 files." }
    });

    expect(stale.percent).toBe(30);
    expect(completed).toMatchObject({ percent: 100, stage: "completed" });
  });

  it("shows actionable terminal failure details without resetting known progress", () => {
    const failed = progressFromRunEvent(
      { percent: 75, title: "Building", stage: "validation" },
      {
        eventId: 7,
        type: "run.failed",
        payload: { code: "BUILD_FAILED", message: "npm run build exited 1." }
      }
    );
    expect(failed).toEqual({
      percent: 75,
      title: "Generation failed · BUILD_FAILED",
      detail: "npm run build exited 1.",
      stage: "failed"
    });
  });
});
