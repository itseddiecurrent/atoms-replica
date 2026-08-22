import { describe, expect, it } from "vitest";

import { getProjectName } from "./project-name";

describe("getProjectName", () => {
  it("normalizes whitespace", () => {
    expect(getProjectName("  Build   a dashboard\n for me  ")).toBe("Build a dashboard for me");
  });

  it("truncates long prompts to a readable project name", () => {
    const name = getProjectName("a".repeat(100));

    expect(name).toHaveLength(60);
    expect(name.endsWith("…")).toBe(true);
  });
});
