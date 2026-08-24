import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptanceQuota,
  dedicatedTestEmail,
  generateHexPassword,
  provisionTestAccount
} from "./provision-test-account.mjs";

function firebaseResponse(body, status = 200) {
  return Promise.resolve(Response.json(body, { status }));
}

describe("dedicated test account provisioning", () => {
  it("creates test@test.com with a generated hex password in a protected ignored file", async () => {
    const writes = [];
    const modes = [];
    const requests = [];
    const result = await provisionTestAccount({
      env: { NEXT_PUBLIC_FIREBASE_API_KEY: "public-firebase-key" },
      randomBytesImpl: () => Buffer.alloc(24, 0xab),
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        return firebaseResponse({ localId: "firebase-user-1" });
      },
      writeFileImpl: async (path, content, options) => writes.push({ path, content, options }),
      chmodImpl: async (path, mode) => modes.push({ path, mode })
    });

    assert.equal(result.email, dedicatedTestEmail);
    assert.equal(result.action, "created");
    assert.equal(result.quota.dailyRuns, 20);
    assert.equal(requests[0].body.email, dedicatedTestEmail);
    assert.match(requests[0].body.password, /^[a-f0-9]{48}$/);
    assert.match(writes[0].content, /E2E_EMAIL=test@test\.com/);
    assert.match(
      writes[0].content,
      /E2E_PASSWORD=abababababababababababababababababababababababab/
    );
    assert.equal(writes[0].options.mode, 0o600);
    assert.equal(modes[0].mode, 0o600);
    assert.equal(JSON.stringify(result).includes(requests[0].body.password), false);
  });

  it("verifies an existing account with the locally stored hex credential", async () => {
    const operations = [];
    const result = await provisionTestAccount({
      env: {
        NEXT_PUBLIC_FIREBASE_API_KEY: "public-firebase-key",
        E2E_PASSWORD: "c".repeat(48)
      },
      fetchImpl: async (url) => {
        operations.push(String(url));
        return firebaseResponse({ localId: "firebase-user-1" });
      },
      writeFileImpl: async () => undefined,
      chmodImpl: async () => undefined
    });

    assert.equal(result.action, "verified");
    assert.match(operations[0], /signInWithPassword/);
    assert.equal(operations.length, 1);
  });

  it("uses Firebase Admin to reset an existing account and verifies the new password", async () => {
    const operations = [];
    const adminAuth = {
      getUserByEmail: async (email) => ({ uid: "existing-user", email }),
      updateUser: async (...args) => operations.push(["updateUser", ...args]),
      revokeRefreshTokens: async (...args) => operations.push(["revokeRefreshTokens", ...args])
    };
    let requestNumber = 0;
    const result = await provisionTestAccount({
      env: {
        NEXT_PUBLIC_FIREBASE_API_KEY: "public-firebase-key",
        E2E_PASSWORD: "d".repeat(48)
      },
      fetchImpl: async (url) => {
        requestNumber += 1;
        operations.push(["request", String(url)]);
        if (requestNumber === 1)
          return firebaseResponse({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, 400);
        if (requestNumber === 2)
          return firebaseResponse({ error: { message: "EMAIL_EXISTS" } }, 400);
        return firebaseResponse({ localId: "existing-user" });
      },
      writeFileImpl: async () => undefined,
      chmodImpl: async () => undefined,
      adminAuthFactory: () => adminAuth
    });

    assert.equal(result.action, "reset-and-verified");
    assert.deepEqual(operations[2], [
      "updateUser",
      "existing-user",
      { password: "d".repeat(48), disabled: false }
    ]);
    assert.deepEqual(operations[3], ["revokeRefreshTokens", "existing-user"]);
    assert.match(operations[4][1], /signInWithPassword/);
  });

  it("requires the generated password shape", async () => {
    await assert.rejects(
      provisionTestAccount({
        env: { NEXT_PUBLIC_FIREBASE_API_KEY: "key", E2E_PASSWORD: "not-a-hex-password" }
      }),
      /48-character lowercase hex/
    );
  });

  it("rejects an account quota below the five-run acceptance requirement", () => {
    assert.throws(() => acceptanceQuota({ MAX_DAILY_RUNS_PER_USER: "4" }), /must be at least 5/);
    assert.throws(
      () => acceptanceQuota({ MAX_MESSAGES_PER_MINUTE_PER_USER: "1" }),
      /must be at least 2/
    );
  });

  it("generates 192 bits as a lowercase hex password", () => {
    assert.equal(
      generateHexPassword(() => Buffer.alloc(24, 0x01)),
      "01".repeat(24)
    );
  });
});
