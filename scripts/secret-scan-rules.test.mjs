import assert from "node:assert/strict";
import test from "node:test";

import { isSensitiveTrackedPath } from "./secret-scan-rules.mjs";

test("allows only the committed environment template", () => {
  assert.equal(isSensitiveTrackedPath(".env.example"), false);
  assert.equal(isSensitiveTrackedPath("apps/web/.env.example"), false);
  assert.equal(isSensitiveTrackedPath("deploy/web.env.example"), false);

  assert.equal(isSensitiveTrackedPath(".env"), true);
  assert.equal(isSensitiveTrackedPath(".env.local"), true);
  assert.equal(isSensitiveTrackedPath("apps/web/.env.production"), true);
});

test("rejects service-account credential files", () => {
  assert.equal(isSensitiveTrackedPath("firebase-admin.json"), true);
  assert.equal(isSensitiveTrackedPath("config/service_account.production.json"), true);
  assert.equal(isSensitiveTrackedPath("config/service-account.example.json"), true);
  assert.equal(isSensitiveTrackedPath("config/firebase.json"), false);
});
