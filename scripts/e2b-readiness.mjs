import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const sandboxWorkdir = "/home/user/app";
const defaultCspOrigin = "https://*.e2b.app";
const probePackage = JSON.stringify({
  name: "atom-e2b-readiness",
  private: true,
  type: "module",
  scripts: { build: "vite build", dev: "vite" },
  devDependencies: { vite: "7.1.0" }
});
const probePage = "<!doctype html><html><body><h1>E2B ready</h1></body></html>";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the E2B readiness check.`);
  return value;
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
}

function confirmed(env, name) {
  if (required(env, name) !== "true")
    throw new Error(`${name} must be exactly true after checking the E2B dashboard.`);
}

function validatedCspOrigin(value) {
  const origin = value?.trim() || defaultCspOrigin;
  if (!/^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(origin))
    throw new Error("E2B_PREVIEW_CSP_ORIGIN must be one HTTPS origin or wildcard subdomain.");
  return origin.toLowerCase();
}

function previewMatchesCsp(previewUrl, cspOrigin) {
  const preview = new URL(previewUrl);
  if (preview.protocol !== "https:") return false;
  const wildcard = cspOrigin.match(/^https:\/\/\*\.([^/:]+)(?::(\d+))?$/i);
  if (wildcard) {
    const port = wildcard[2] || "";
    return (
      preview.hostname.endsWith(`.${wildcard[1]}`) &&
      preview.hostname !== wildcard[1] &&
      preview.port === port
    );
  }
  return preview.origin.toLowerCase() === cspOrigin;
}

export function e2bRuntimeConfig(env = process.env) {
  const config = {
    templateId: env.E2B_TEMPLATE_ID?.trim() || "default",
    sandboxTimeoutSeconds: positiveInteger(env, "E2B_SANDBOX_TIMEOUT_SECONDS", 900),
    previewPort: positiveInteger(env, "E2B_PREVIEW_PORT", 5173),
    commandTimeoutSeconds: positiveInteger(env, "MAX_COMMAND_DURATION_SECONDS", 120),
    workerConcurrency: positiveInteger(env, "WORKER_CONCURRENCY", 1),
    cspOrigin: validatedCspOrigin(env.E2B_PREVIEW_CSP_ORIGIN)
  };
  if (config.sandboxTimeoutSeconds < 600)
    throw new Error("E2B_SANDBOX_TIMEOUT_SECONDS must be at least 600 for acceptance Runs.");
  if (config.commandTimeoutSeconds < 120)
    throw new Error("MAX_COMMAND_DURATION_SECONDS must be at least 120 for npm install and build.");
  if (config.previewPort < 1024 || config.previewPort > 65_535)
    throw new Error("E2B_PREVIEW_PORT must be between 1024 and 65535.");
  if (config.workerConcurrency < 1)
    throw new Error("WORKER_CONCURRENCY must allow at least one Sandbox.");
  return config;
}

function commandOutput(error) {
  if (!error || typeof error !== "object") return String(error);
  const value = error;
  return [value.stderr, value.stdout, value.message]
    .find((item) => typeof item === "string" && item.trim())
    ?.trim()
    .slice(0, 1_000);
}

async function runCommand(sandbox, command, options, label) {
  let result;
  try {
    result = await sandbox.commands.run(command, options);
  } catch (error) {
    if (typeof error?.exitCode === "number")
      throw new Error(`${label} failed with exit code ${error.exitCode}: ${commandOutput(error)}`);
    throw new Error(`${label} failed: ${commandOutput(error)}`);
  }
  if ((result.exitCode ?? 0) !== 0)
    throw new Error(
      `${label} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || "no diagnostic output"}`
    );
  return result;
}

async function liveSandboxFactory({ apiKey, templateId, timeoutMs }) {
  const requireFromSandbox = createRequire(
    new URL("../packages/sandbox/package.json", import.meta.url)
  );
  const sdkPath = requireFromSandbox.resolve("e2b");
  const { Sandbox } = await import(pathToFileURL(sdkPath).href);
  const connectionOptions = { apiKey, timeoutMs };
  return templateId === "default"
    ? Sandbox.create(connectionOptions)
    : Sandbox.create(templateId, connectionOptions);
}

export async function verifyE2BReadiness({
  env = process.env,
  createSandbox = liveSandboxFactory,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  const apiKey = required(env, "E2B_API_KEY");
  const config = e2bRuntimeConfig(env);
  confirmed(env, "E2B_CREDITS_CONFIRMED");
  confirmed(env, "E2B_CONCURRENCY_CONFIRMED");

  const createdAt = Date.now();
  let sandbox;
  let released = false;
  let releasedAt;
  let evidence;
  try {
    sandbox = await createSandbox({
      apiKey,
      templateId: config.templateId,
      timeoutMs: config.sandboxTimeoutSeconds * 1_000
    });
    const createdInMs = Date.now() - createdAt;
    const commandOptions = {
      cwd: sandboxWorkdir,
      timeoutMs: config.commandTimeoutSeconds * 1_000
    };

    await runCommand(
      sandbox,
      `mkdir -p ${sandboxWorkdir}`,
      { timeoutMs: 10_000 },
      "Workspace preparation"
    );
    await sandbox.files.write(`${sandboxWorkdir}/package.json`, probePackage);
    await sandbox.files.write(`${sandboxWorkdir}/index.html`, probePage);
    const versions = await runCommand(
      sandbox,
      "node --version && npm --version",
      commandOptions,
      "Node/npm check"
    );
    const versionLines = String(versions.stdout || "")
      .trim()
      .split(/\s+/);
    if (!/^v\d+/.test(versionLines[0] || "") || !/^\d+\.\d+/.test(versionLines[1] || ""))
      throw new Error("E2B Template did not report usable Node and npm versions.");

    await runCommand(sandbox, "npm install --no-audit --no-fund", commandOptions, "npm install");
    await runCommand(sandbox, "npm run build", commandOptions, "Production build");
    await runCommand(
      sandbox,
      `npm run dev -- --host 0.0.0.0 --port ${config.previewPort}`,
      { cwd: sandboxWorkdir, background: true },
      "Vite Preview start"
    );

    const host = sandbox.getHost(config.previewPort);
    const previewUrl = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    if (!previewMatchesCsp(previewUrl, config.cspOrigin))
      throw new Error(
        `E2B Preview URL is not allowed by E2B_PREVIEW_CSP_ORIGIN (${config.cspOrigin}).`
      );

    const previewDeadline = Date.now() + 60_000;
    let previewStatus;
    while (Date.now() < previewDeadline) {
      try {
        const response = await fetchImpl(previewUrl, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          previewStatus = response.status;
          break;
        }
      } catch {
        // Vite may still be starting; retry until the bounded deadline.
      }
      await sleep(500);
    }
    if (!previewStatus)
      throw new Error("E2B HTTPS Preview did not become healthy within 60 seconds.");

    evidence = {
      verifiedAt: new Date().toISOString(),
      sandboxId: sandbox.sandboxId,
      createdInMs,
      templateId: config.templateId,
      nodeVersion: versionLines[0],
      npmVersion: versionLines[1],
      install: "passed",
      productionBuild: "passed",
      previewUrl,
      previewStatus,
      config,
      credits: "confirmed",
      concurrency: "confirmed"
    };
  } finally {
    if (sandbox) {
      const releaseStartedAt = Date.now();
      await sandbox.kill();
      releasedAt = Date.now();
      released = true;
      if (evidence) evidence.releaseInMs = releasedAt - releaseStartedAt;
    }
  }

  if (!evidence || !released)
    throw new Error("E2B readiness did not produce evidence of Sandbox creation and release.");
  return { ...evidence, released };
}

export function formatE2BReadinessReport(result) {
  return `# E2B Runtime Readiness Record

| Field | Evidence |
| --- | --- |
| Verified at | ${result.verifiedAt} |
| Sandbox ID | \`${result.sandboxId}\` |
| Template | \`${result.templateId}\` |
| Sandbox created in | ${result.createdInMs} ms |
| Node / npm | ${result.nodeVersion} / ${result.npmVersion} |
| File write and npm install | ${result.install} |
| Production build | ${result.productionBuild} |
| HTTPS Preview | HTTP ${result.previewStatus} at ${result.previewUrl} |
| Preview CSP origin | \`${result.config.cspOrigin}\` |
| Sandbox timeout | ${result.config.sandboxTimeoutSeconds} seconds |
| Command timeout | ${result.config.commandTimeoutSeconds} seconds |
| Preview port | ${result.config.previewPort} |
| Worker/Sandbox concurrency | ${result.config.workerConcurrency} / ${result.concurrency} |
| E2B Credits | ${result.credits} |
| Sandbox released | ${result.released} in ${result.releaseInMs} ms |
`;
}

async function main() {
  const result = await verifyE2BReadiness();
  process.stdout.write(formatE2BReadinessReport(result));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
