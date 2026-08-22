import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, productionSecurityHeaders } from "./security-headers";

describe("production security headers", () => {
  it("allows only the configured Preview origin in frames and connections", () => {
    const policy = contentSecurityPolicy("https://*.sandbox.example.com");
    expect(policy).toContain("frame-src 'self'");
    expect(policy).toContain("https://*.sandbox.example.com");
    expect(policy).toContain("wss://*.sandbox.example.com");
    expect(policy).not.toContain("frame-src *");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("rejects unsafe or header-injecting Preview origins", () => {
    expect(() => contentSecurityPolicy("*")).toThrow();
    expect(() => contentSecurityPolicy("http://preview.example.com")).toThrow();
    expect(() => contentSecurityPolicy("https://safe.example.com\nX-Evil: yes")).toThrow();
  });

  it("sets browser hardening headers", () => {
    expect(productionSecurityHeaders()).toEqual(
      expect.arrayContaining([
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" }
      ])
    );
  });
});
