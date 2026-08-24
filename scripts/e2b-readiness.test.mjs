import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  e2bRuntimeConfig,
  formatE2BReadinessReport,
  verifyE2BReadiness
} from "./e2b-readiness.mjs";

function environment(overrides = {}) {
  return {
    E2B_API_KEY: "test-only-e2b-key",
    E2B_TEMPLATE_ID: "template-1",
    E2B_SANDBOX_TIMEOUT_SECONDS: "900",
    E2B_PREVIEW_PORT: "5173",
    E2B_PREVIEW_CSP_ORIGIN: "https://*.e2b.app",
    MAX_COMMAND_DURATION_SECONDS: "120",
    WORKER_CONCURRENCY: "1",
    E2B_CREDITS_CONFIRMED: "true",
    E2B_CONCURRENCY_CONFIRMED: "true",
    ...overrides
  };
}

function fakeRuntime(overrides = {}) {
  const writes = [];
  const commands = [];
  const sandbox = {
    sandboxId: "sandbox-1",
    files: {
      write: async (path, content) => void writes.push([path, content])
    },
    commands: {
      run: async (command, options) => {
        commands.push([command, options]);
        if (command === "node --version && npm --version")
          return { exitCode: 0, stdout: "v22.18.0\n10.9.3\n", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    getHost: () => "5173-sandbox-1.e2b.app",
    kill: async () => undefined,
    ...overrides
  };
  return { sandbox, writes, commands, createSandbox: async () => sandbox };
}

describe("E2B production readiness verifier", () => {
  it("creates, writes, installs, builds, previews, and releases a remote Sandbox", async () => {
    const runtime = fakeRuntime();
    const result = await verifyE2BReadiness({
      env: environment(),
      createSandbox: runtime.createSandbox,
      fetchImpl: async () => new Response("ok", { status: 200 })
    });

    assert.equal(result.released, true);
    assert.equal(result.previewStatus, 200);
    assert.equal(result.nodeVersion, "v22.18.0");
    assert.deepEqual(
      runtime.commands.map(([command]) => command),
      [
        "mkdir -p /home/user/app",
        "node --version && npm --version",
        "npm install --no-audit --no-fund",
        "npm run build",
        "./node_modules/.bin/vite --host 0.0.0.0 --port 5173 --strictPort"
      ]
    );
    assert.equal(runtime.writes.length, 2);
  });

  it("produces evidence without the API key or probe source", async () => {
    const env = environment();
    const runtime = fakeRuntime();
    const result = await verifyE2BReadiness({
      env,
      createSandbox: runtime.createSandbox,
      fetchImpl: async () => new Response("ok", { status: 200 })
    });
    const report = formatE2BReadinessReport(result);

    assert.doesNotMatch(report, new RegExp(env.E2B_API_KEY));
    assert.doesNotMatch(report, /E2B ready|package\.json|index\.html/);
    assert.match(report, /Sandbox released \| true/);
  });

  it("rejects insufficient timeout, command, port, and unsafe CSP configuration", () => {
    assert.throws(
      () => e2bRuntimeConfig(environment({ E2B_SANDBOX_TIMEOUT_SECONDS: "599" })),
      /must be at least 600/
    );
    assert.throws(
      () => e2bRuntimeConfig(environment({ MAX_COMMAND_DURATION_SECONDS: "119" })),
      /must be at least 120/
    );
    assert.throws(
      () => e2bRuntimeConfig(environment({ E2B_PREVIEW_PORT: "80" })),
      /between 1024 and 65535/
    );
    assert.throws(
      () => e2bRuntimeConfig(environment({ E2B_PREVIEW_CSP_ORIGIN: "*" })),
      /must be one HTTPS origin/
    );
  });

  it("requires explicit Credits and concurrency dashboard confirmations", async () => {
    const runtime = fakeRuntime();
    await assert.rejects(
      verifyE2BReadiness({
        env: environment({ E2B_CREDITS_CONFIRMED: "false" }),
        createSandbox: runtime.createSandbox
      }),
      /E2B_CREDITS_CONFIRMED must be exactly true/
    );
  });

  it("rejects a Preview hostname outside the production CSP and still releases it", async () => {
    let killed = false;
    const runtime = fakeRuntime({
      getHost: () => "preview.untrusted.example",
      kill: async () => void (killed = true)
    });
    await assert.rejects(
      verifyE2BReadiness({
        env: environment(),
        createSandbox: runtime.createSandbox,
        fetchImpl: async () => new Response("ok", { status: 200 })
      }),
      /not allowed by E2B_PREVIEW_CSP_ORIGIN/
    );
    assert.equal(killed, true);
  });

  it("reports a missing npm/build failure with its exit code and releases the Sandbox", async () => {
    let killed = false;
    const runtime = fakeRuntime({
      commands: {
        run: async (command) => {
          if (command === "node --version && npm --version")
            throw Object.assign(new Error("exit status 127"), {
              exitCode: 127,
              stderr: "sh: npm: command not found"
            });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
      },
      kill: async () => void (killed = true)
    });
    await assert.rejects(
      verifyE2BReadiness({ env: environment(), createSandbox: runtime.createSandbox }),
      /Node\/npm check failed with exit code 127: sh: npm: command not found/
    );
    assert.equal(killed, true);
  });
});
