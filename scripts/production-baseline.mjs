import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the production baseline.`);
  return value;
}

function confirmed(env, name) {
  if (required(env, name) !== "true")
    throw new Error(`${name} must be exactly true after manual verification.`);
}

function normalizeRepositoryUrl(value) {
  const ssh = value.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/, "")}`;
  return value.replace(/\.git$/, "");
}

function validateCommit(value, name) {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error(`${name} must be a full 40-character SHA.`);
  return value.toLowerCase();
}

function validatePublicUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("BASELINE_PUBLIC_URL must use HTTPS.");
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  )
    throw new Error("BASELINE_PUBLIC_URL must target the public production service.");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function localGitEvidence() {
  const run = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  return {
    repositoryUrl: normalizeRepositoryUrl(run("remote", "get-url", "origin")),
    commitSha: run("rev-parse", "HEAD")
  };
}

async function request(fetchImpl, url, kind) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new Error(`${kind} request failed: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status !== 200) throw new Error(`${kind} returned HTTP ${response.status}.`);
  return response;
}

export async function verifyProductionBaseline({
  env = process.env,
  fetchImpl = fetch,
  gitEvidence = localGitEvidence()
} = {}) {
  const publicUrl = validatePublicUrl(
    required(
      { ...env, BASELINE_PUBLIC_URL: env.BASELINE_PUBLIC_URL ?? env.E2E_BASE_URL },
      "BASELINE_PUBLIC_URL"
    )
  );
  const repositoryUrl = normalizeRepositoryUrl(
    env.BASELINE_GITHUB_URL?.trim() || gitEvidence.repositoryUrl
  );
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(repositoryUrl))
    throw new Error("The production baseline requires a canonical GitHub repository URL.");

  const commitSha = validateCommit(
    env.BASELINE_COMMIT_SHA?.trim() || gitEvidence.commitSha,
    "BASELINE_COMMIT_SHA"
  );
  const webCommitSha = validateCommit(
    required(env, "BASELINE_WEB_COMMIT_SHA"),
    "BASELINE_WEB_COMMIT_SHA"
  );
  const workerCommitSha = validateCommit(
    required(env, "BASELINE_WORKER_COMMIT_SHA"),
    "BASELINE_WORKER_COMMIT_SHA"
  );
  if (webCommitSha !== commitSha || workerCommitSha !== commitSha)
    throw new Error("Web, Worker, and the baseline commit SHA must match exactly.");

  confirmed(env, "BASELINE_WORKER_POLLING_CONFIRMED");
  confirmed(env, "BASELINE_FIREBASE_AUTH_CONFIRMED");

  const [homepage, login, healthResponse] = await Promise.all([
    request(fetchImpl, new URL("/", publicUrl), "Production homepage"),
    request(fetchImpl, new URL("/login", publicUrl), "Production login page"),
    request(fetchImpl, new URL("/api/health", publicUrl), "Web health endpoint")
  ]);
  const health = await healthResponse.json().catch(() => undefined);
  if (!health || health.status !== "ok" || health.service !== "web" || health.database !== "ok")
    throw new Error("Web health response does not confirm the Web service and database are ready.");

  return {
    verifiedAt: new Date().toISOString(),
    repositoryUrl,
    commitSha,
    publicUrl: publicUrl.origin,
    web: {
      deploymentId: required(env, "BASELINE_WEB_DEPLOYMENT_ID"),
      commitSha: webCommitSha,
      homepageStatus: homepage.status,
      healthStatus: healthResponse.status,
      database: health.database
    },
    worker: {
      deploymentId: required(env, "BASELINE_WORKER_DEPLOYMENT_ID"),
      commitSha: workerCommitSha,
      pollingConfirmed: true
    },
    firebaseAuthConfirmed: true,
    loginStatus: login.status
  };
}

export function formatBaselineReport(result) {
  return `# Production Baseline Record

| Field | Evidence |
| --- | --- |
| Verified at | ${result.verifiedAt} |
| GitHub repository | ${result.repositoryUrl} |
| Commit SHA | \`${result.commitSha}\` |
| Public URL | ${result.publicUrl} |
| Web deployment | \`${result.web.deploymentId}\` |
| Web commit | \`${result.web.commitSha}\` |
| Web health | HTTP ${result.web.healthStatus}, database ${result.web.database} |
| Worker deployment | \`${result.worker.deploymentId}\` |
| Worker commit | \`${result.worker.commitSha}\` |
| Worker polling | Confirmed |
| Firebase registration/login | Confirmed |
`;
}

async function main() {
  const result = await verifyProductionBaseline();
  process.stdout.write(formatBaselineReport(result));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
