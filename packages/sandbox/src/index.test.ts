import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  E2BSandboxAdapter,
  SANDBOX_PREVIEW_SERVER_SOURCE,
  SANDBOX_WORKDIR,
  SandboxLifecycleError,
  ensureSandbox,
  normalizeSandboxPath,
  sandboxPreviewCommand,
  type E2BSandboxClient,
  type E2BSandboxSdk
} from "./index";

function fakeSandbox(): E2BSandboxClient & {
  writes: Array<[string, string]>;
  commandsRun: Array<[string, Record<string, unknown> | undefined]>;
} {
  const writes: Array<[string, string]> = [];
  const commandsRun: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    sandboxId: "sb-test",
    writes,
    commandsRun,
    files: {
      write: vi.fn(async (path: string, data: string) => {
        writes.push([path, data]);
      }),
      read: vi.fn(async () => "file contents"),
      remove: vi.fn(async () => undefined),
      list: vi.fn(async () => [
        { path: `${SANDBOX_WORKDIR}/src/App.tsx` },
        { name: "package.json" }
      ])
    },
    commands: {
      run: vi.fn(async (command: string, options?: Record<string, unknown>) => {
        commandsRun.push([command, options]);
        return { exitCode: 0, stdout: "okay", stderr: "" };
      })
    },
    kill: vi.fn(async () => undefined),
    setTimeout: vi.fn(async () => undefined),
    isRunning: vi.fn(async () => true),
    getHost: vi.fn(() => "https://sandbox.example.test")
  };
}

describe("sandbox path safety", () => {
  it("accepts relative POSIX paths and rejects traversal", () => {
    expect(normalizeSandboxPath("./src/App.tsx")).toBe("src/App.tsx");
    expect(() => normalizeSandboxPath("/etc/passwd")).toThrow();
    expect(() => normalizeSandboxPath("src/../../secret")).toThrow();
    expect(() => normalizeSandboxPath("src\\App.tsx")).toThrow();
  });
});

describe("Sandbox Preview command", () => {
  it("uses the Node-compatible static server on a validated port", () => {
    expect(sandboxPreviewCommand(5173)).toBe("node /tmp/atom-replica-preview.mjs 5173");
    expect(() => sandboxPreviewCommand(80)).toThrow(/between 1024 and 65535/);
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: SANDBOX_PREVIEW_SERVER_SOURCE,
      encoding: "utf8"
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});

describe("ensureSandbox", () => {
  function adapter() {
    return {
      create: vi.fn(async () => "new-sandbox"),
      connect: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      deleteFile: vi.fn(async () => undefined),
      listFiles: vi.fn(async () => []),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "installed", stderr: "" })),
      startDevServer: vi.fn(async () => undefined),
      restartDevServer: vi.fn(async () => undefined),
      getPreviewUrl: vi.fn(async () => "https://preview.test"),
      kill: vi.fn(async () => undefined)
    };
  }

  it("reuses a valid connected sandbox", async () => {
    const sandbox = adapter();
    await expect(
      ensureSandbox({
        adapter: sandbox,
        sandboxId: "existing",
        sandboxExpiresAt: new Date("2027-01-01"),
        projectFiles: [],
        now: new Date("2026-01-01")
      })
    ).resolves.toEqual({ sandboxId: "existing", created: false });
    expect(sandbox.create).not.toHaveBeenCalled();
  });

  it("recreates from snapshot and overlays newer project files", async () => {
    const sandbox = adapter();
    sandbox.connect.mockRejectedValue(new Error("expired"));
    await expect(
      ensureSandbox({
        adapter: sandbox,
        sandboxId: "missing",
        sandboxExpiresAt: new Date("2027-01-01"),
        snapshotFiles: [{ path: "src/App.tsx", content: "snapshot" }],
        projectFiles: [{ path: "src/App.tsx", content: "newest" }],
        now: new Date("2026-01-01"),
        previewPort: 5173
      })
    ).resolves.toEqual({
      sandboxId: "new-sandbox",
      created: true,
      previewUrl: "https://preview.test"
    });
    expect(sandbox.writeFile.mock.calls).toEqual([
      ["src/App.tsx", "snapshot"],
      ["src/App.tsx", "newest"]
    ]);
    expect(sandbox.runCommand).toHaveBeenCalledWith("npm install --no-audit --no-fund", {
      timeoutMs: 120_000
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("npm run build", {
      timeoutMs: 120_000
    });
    expect(sandbox.startDevServer).toHaveBeenCalledWith({ port: 5173 });
  });

  it("does not start Preview when a restored project fails to build", async () => {
    const sandbox = adapter();
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "source detail" });

    await expect(
      ensureSandbox({ adapter: sandbox, projectFiles: [{ path: "src/App.tsx", content: "code" }] })
    ).rejects.toMatchObject({
      code: "SANDBOX_RESTORE_BUILD_FAILED",
      message: "Sandbox restore build exited with code 1."
    });
    expect(sandbox.startDevServer).not.toHaveBeenCalled();
  });
});

describe("E2BSandboxAdapter", () => {
  it("creates a sandbox and copies the fixed template without secrets or build output", async () => {
    const sandbox = fakeSandbox();
    const sdk: E2BSandboxSdk = { create: vi.fn(async () => sandbox), connect: vi.fn() };
    const adapter = new E2BSandboxAdapter({
      sdk,
      templateDir: resolve("../../templates/react-vite"),
      timeoutMs: 1234
    });

    await expect(adapter.create()).resolves.toBe("sb-test");
    expect(sdk.create).toHaveBeenCalledWith({ timeoutMs: 1234 });
    expect(sandbox.writes.some(([path]) => path === `${SANDBOX_WORKDIR}/package.json`)).toBe(true);
    expect(
      sandbox.writes.some(([path]) => path.includes("node_modules") || path.includes("dist"))
    ).toBe(false);
  });

  it("maps files and commands into the fixed workspace and caps output", async () => {
    const sandbox = fakeSandbox();
    const onProviderCall = vi.fn();
    const sdk: E2BSandboxSdk = { create: vi.fn(), connect: vi.fn(async () => sandbox) };
    const adapter = new E2BSandboxAdapter({
      sdk,
      templateDir: resolve("../../templates/react-vite"),
      maxOutputChars: 3,
      onProviderCall
    });
    await adapter.connect("sb-test");
    expect(sandbox.setTimeout).toHaveBeenCalledWith(15 * 60 * 1000, {
      requestTimeoutMs: 60_000
    });
    expect(sdk.connect).toHaveBeenCalledWith("sb-test", { requestTimeoutMs: 60_000 });
    expect(sandbox.isRunning).toHaveBeenCalledWith({ requestTimeoutMs: 10_000 });
    await adapter.writeFile("src/App.tsx", "updated");
    await expect(adapter.readFile("src/App.tsx")).resolves.toBe("file contents");
    await expect(adapter.listFiles()).resolves.toEqual(["package.json", "src/App.tsx"]);
    await expect(adapter.runCommand("pnpm build")).resolves.toEqual({
      exitCode: 0,
      stdout: "oka\n[… output truncated …]",
      stderr: ""
    });
    expect(sandbox.commandsRun[0]).toEqual([
      "pnpm build",
      { cwd: SANDBOX_WORKDIR, timeoutMs: 60000 }
    ]);
    expect(sandbox.writes[0]).toEqual([`${SANDBOX_WORKDIR}/src/App.tsx`, "updated"]);
    expect(onProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "commands.run", status: "ok" })
    );
  });

  it("normalizes E2B non-zero command exits into command results", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run = vi.fn().mockRejectedValue(
      Object.assign(new Error("exit status 127"), {
        exitCode: 127,
        stdout: "",
        stderr: "sh: pnpm: command not found"
      })
    );
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    await adapter.connect("sb-test");

    await expect(adapter.runCommand("pnpm build")).resolves.toEqual({
      exitCode: 127,
      stdout: "",
      stderr: "sh: pnpm: command not found"
    });
  });

  it("turns the E2B Preview hostname into an HTTPS URL", async () => {
    const sandbox = fakeSandbox();
    sandbox.getHost = vi.fn(() => "5173-sb-test.e2b.app");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) },
      templateDir: resolve("../../templates/react-vite"),
      fetchImpl
    });
    await adapter.connect("sb-test");
    await expect(adapter.getPreviewUrl(5173)).resolves.toBe("https://5173-sb-test.e2b.app");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://5173-sb-test.e2b.app",
      expect.objectContaining({ headers: { "Cache-Control": "no-cache" } })
    );
  });

  it("classifies reconnect and TTL renewal failures without provider details", async () => {
    const reconnecting = new E2BSandboxAdapter({
      sdk: {
        create: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error("provider reconnect secret"))
      }
    });
    await expect(reconnecting.connect("sb-test")).rejects.toEqual(
      expect.objectContaining({
        code: "SANDBOX_RECONNECT_FAILED",
        message: "Could not reconnect to the existing E2B Sandbox."
      })
    );

    const sandbox = fakeSandbox();
    sandbox.setTimeout = vi.fn().mockRejectedValue(new Error("provider timeout secret"));
    const renewing = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    const error = await renewing.connect("sb-test").catch((caught) => caught);
    expect(error).toBeInstanceOf(SandboxLifecycleError);
    expect(error).toMatchObject({
      code: "SANDBOX_TTL_RENEWAL_FAILED",
      message: "Could not renew the E2B Sandbox lifetime."
    });
    expect(String(error)).not.toContain("provider timeout secret");
  });

  it("waits for a reconnected Sandbox environment before using its filesystem", async () => {
    const sandbox = fakeSandbox();
    sandbox.isRunning = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });

    await adapter.connect("sb-test");

    expect(sandbox.isRunning).toHaveBeenCalledTimes(3);
  });

  it("recursively lists files while omitting directory entries", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.list = vi.fn(async (path: string) =>
      path === SANDBOX_WORKDIR
        ? [
            { path: `${SANDBOX_WORKDIR}/src`, type: "dir" },
            { path: `${SANDBOX_WORKDIR}/node_modules`, type: "dir" },
            { path: `${SANDBOX_WORKDIR}/dist`, type: "dir" },
            { path: `${SANDBOX_WORKDIR}/.env`, type: "file" },
            { path: `${SANDBOX_WORKDIR}/package.json`, type: "file" }
          ]
        : [{ path: `${SANDBOX_WORKDIR}/src/App.tsx`, type: "file" }]
    );
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    await adapter.connect("sb-test");

    await expect(adapter.listFiles()).resolves.toEqual(["package.json", "src/App.tsx"]);
    expect(sandbox.files.list).toHaveBeenCalledTimes(2);
    expect(sandbox.files.list).not.toHaveBeenCalledWith(`${SANDBOX_WORKDIR}/node_modules`);
    expect(sandbox.files.list).not.toHaveBeenCalledWith(`${SANDBOX_WORKDIR}/dist`);
  });

  it("starts Vite in the background and waits for a healthy preview", async () => {
    const sandbox = fakeSandbox();
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) },
      templateDir: resolve("../../templates/react-vite"),
      fetchImpl
    });
    await adapter.connect("sb-test");
    await adapter.startDevServer();
    await expect(adapter.getPreviewUrl()).resolves.toBe("https://sandbox.example.test");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sandbox.example.test",
      expect.objectContaining({ headers: { "Cache-Control": "no-cache" } })
    );
    expect(sandbox.commandsRun.map(([command]) => command)).toEqual([
      "pkill -f '/tmp/[a]tom-replica-preview.mjs 5173' || true",
      "node /tmp/atom-replica-preview.mjs 5173"
    ]);
    expect(vi.mocked(sandbox.commands.run).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.files.remove).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(sandbox.files.remove).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.files.write).mock.invocationCallOrder[0]!
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/tmp/atom-replica-preview.mjs",
      expect.stringContaining('from "node:http"')
    );
  });

  it("retries the idempotent Preview launcher write after a transient reconnect failure", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.write = vi
      .fn()
      .mockRejectedValueOnce(new Error("environment not ready"))
      .mockResolvedValue(undefined);
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    await adapter.connect("sb-test");

    await adapter.startDevServer();

    expect(sandbox.files.write).toHaveBeenCalledTimes(2);
  });

  it("starts Preview when no previous launcher file exists", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.remove = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("missing"), { name: "FileNotFoundError" }));
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    await adapter.connect("sb-test");

    await adapter.startDevServer();

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/tmp/atom-replica-preview.mjs",
      SANDBOX_PREVIEW_SERVER_SOURCE
    );
  });

  it("keeps the Preview launcher retry bounded when the filesystem remains unavailable", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = fakeSandbox();
      sandbox.files.write = vi.fn().mockRejectedValue(new Error("environment not ready"));
      const adapter = new E2BSandboxAdapter({
        sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
      });
      await adapter.connect("sb-test");

      const starting = expect(adapter.startDevServer()).rejects.toMatchObject({
        code: "PREVIEW_PREPARE_FAILED"
      });
      await vi.runAllTimersAsync();

      await starting;
      expect(sandbox.files.write).toHaveBeenCalledTimes(10);
      expect(sandbox.commandsRun.map(([command]) => command)).toEqual([
        "pkill -f '/tmp/[a]tom-replica-preview.mjs 5173' || true"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts Vite on the configured preview port", async () => {
    const sandbox = fakeSandbox();
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) },
      previewPort: 4173
    });
    await adapter.connect("sb-test");

    await adapter.restartDevServer();

    expect(sandbox.commandsRun.map(([command]) => command)).toEqual([
      "pkill -f '/tmp/[a]tom-replica-preview.mjs 4173' || true",
      "node /tmp/atom-replica-preview.mjs 4173"
    ]);
    expect(sandbox.commandsRun[1]?.[1]).toEqual(
      expect.objectContaining({ cwd: SANDBOX_WORKDIR, background: true })
    );
  });

  it("adds process and Sandbox-local diagnostics when the public Preview stays unhealthy", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run = vi.fn(async (command: string, options?: Record<string, unknown>) => {
      sandbox.commandsRun.push([command, options]);
      if (options?.background)
        return {
          wait: async () => ({ exitCode: 1, stdout: "", stderr: "address already in use" })
        };
      if (command.startsWith("node -e")) return { exitCode: 1, stdout: "", stderr: "ECONNREFUSED" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) },
      commandTimeoutMs: 1,
      fetchImpl: vi.fn(async () => new Response("bad gateway", { status: 502 }))
    });
    await adapter.connect("sb-test");
    await adapter.startDevServer();

    const error = await adapter.getPreviewUrl().catch((caught) => caught);
    expect(error).toMatchObject({
      code: "PREVIEW_HEALTH_FAILED",
      message: "The Preview did not become healthy."
    });
    expect((error as SandboxLifecycleError).cause).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(
          /HTTP 502.*Sandbox-local probe: ECONNREFUSED.*exited with code 1.*address already in use/
        )
      })
    );
  });
});
