import { describe, expect, it } from "vitest";

import { activeRestartPreviewJob } from "./repositories";

describe("activeRestartPreviewJob", () => {
  it("reuses an in-flight Preview restart for repeated Workspace opens", () => {
    expect(activeRestartPreviewJob({ id: "job-1", type: "restart_preview" })).toEqual({
      status: "queued",
      runtimeJobId: "job-1",
      reused: true
    });
  });

  it("keeps file synchronization mutually exclusive with Preview restart", () => {
    expect(activeRestartPreviewJob({ id: "job-1", type: "sync_file" })).toEqual({
      status: "runtime_busy"
    });
    expect(activeRestartPreviewJob(undefined)).toBeUndefined();
  });
});
