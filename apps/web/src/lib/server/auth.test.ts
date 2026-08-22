import { describe, expect, it } from "vitest";

import { assertResourceOwner, AuthenticationRequiredError } from "./auth";

describe("resource authorization", () => {
  it("allows the resource owner", () => {
    expect(() => assertResourceOwner("user-1", "user-1")).not.toThrow();
  });

  it("rejects a different user", () => {
    expect(() => assertResourceOwner("user-1", "user-2")).toThrow(AuthenticationRequiredError);
  });
});
