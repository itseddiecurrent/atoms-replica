import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBaselineReport, verifyProductionBaseline } from "./production-baseline.mjs";

const sha = "a".repeat(40);

function environment(overrides = {}) {
  return {
    BASELINE_PUBLIC_URL: "https://atom.example.com",
    BASELINE_WEB_DEPLOYMENT_ID: "web-deployment-1",
    BASELINE_WEB_COMMIT_SHA: sha,
    BASELINE_WORKER_DEPLOYMENT_ID: "worker-deployment-1",
    BASELINE_WORKER_COMMIT_SHA: sha,
    BASELINE_WORKER_POLLING_CONFIRMED: "true",
    BASELINE_FIREBASE_AUTH_CONFIRMED: "true",
    ...overrides
  };
}

function successfulFetch(url) {
  const path = new URL(url).pathname;
  if (path === "/api/health")
    return Promise.resolve(
      Response.json({ status: "ok", service: "web", database: "ok" }, { status: 200 })
    );
  return Promise.resolve(new Response("ok", { status: 200 }));
}

const gitEvidence = {
  repositoryUrl: "git@github.com:itseddiecurrent/atoms-replica.git",
  commitSha: sha
};

describe("production baseline verifier", () => {
  it("verifies a public release and produces a secret-free evidence record", async () => {
    const result = await verifyProductionBaseline({
      env: environment(),
      fetchImpl: successfulFetch,
      gitEvidence
    });

    assert.equal(result.repositoryUrl, "https://github.com/itseddiecurrent/atoms-replica");
    assert.equal(result.web.database, "ok");
    assert.equal(result.worker.pollingConfirmed, true);
    const report = formatBaselineReport(result);
    assert.match(report, /web-deployment-1/);
    assert.match(report, /Firebase registration\/login \| Confirmed/);
    assert.doesNotMatch(report, /API_KEY|PASSWORD|PRIVATE_KEY/);
  });

  it("rejects localhost and non-HTTPS targets", async () => {
    await assert.rejects(
      verifyProductionBaseline({
        env: environment({ BASELINE_PUBLIC_URL: "http://localhost:3000" }),
        fetchImpl: successfulFetch,
        gitEvidence
      }),
      /must use HTTPS/
    );
  });

  it("rejects deployments that do not use the baseline commit", async () => {
    await assert.rejects(
      verifyProductionBaseline({
        env: environment({ BASELINE_WORKER_COMMIT_SHA: "b".repeat(40) }),
        fetchImpl: successfulFetch,
        gitEvidence
      }),
      /must match exactly/
    );
  });

  it("requires explicit Worker and Firebase confirmations", async () => {
    await assert.rejects(
      verifyProductionBaseline({
        env: environment({ BASELINE_WORKER_POLLING_CONFIRMED: "false" }),
        fetchImpl: successfulFetch,
        gitEvidence
      }),
      /must be exactly true/
    );
  });

  it("fails when Web health does not confirm database readiness", async () => {
    await assert.rejects(
      verifyProductionBaseline({
        env: environment(),
        fetchImpl: (url) => {
          if (new URL(url).pathname === "/api/health")
            return Promise.resolve(
              Response.json(
                { status: "unavailable", service: "web", database: "unavailable" },
                { status: 503 }
              )
            );
          return successfulFetch(url);
        },
        gitEvidence
      }),
      /returned HTTP 503/
    );
  });
});
