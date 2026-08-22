import { describe, expect, it } from "vitest";

import { getSafeNextPath, needsAuthentication } from "./routing";

describe("authentication routing", () => {
  it("accepts local next paths and rejects external redirects", () => {
    expect(getSafeNextPath("/projects/123")).toBe("/projects/123");
    expect(getSafeNextPath("//attacker.example")).toBe("/projects");
    expect(getSafeNextPath("https://attacker.example")).toBe("/projects");
  });

  it("protects project routes when the session cookie is absent", () => {
    expect(needsAuthentication("/projects", false)).toBe(true);
    expect(needsAuthentication("/projects/123", true)).toBe(false);
    expect(needsAuthentication("/login", false)).toBe(false);
  });
});
