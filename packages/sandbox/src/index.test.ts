import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  E2BSandboxAdapter,
  SANDBOX_WORKDIR,
  ensureSandbox,
  normalizeSandboxPath,
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
    expect(sandbox.startDevServer).toHaveBeenCalledWith({ port: 5173 });
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
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) },
      templateDir: resolve("../../templates/react-vite"),
      maxOutputChars: 3,
      onProviderCall
    });
    await adapter.connect("sb-test");
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
    expect(fetchImpl).toHaveBeenCalledWith("https://5173-sb-test.e2b.app");
  });

  it("recursively lists files while omitting directory entries", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.list = vi.fn(async (path: string) =>
      path === SANDBOX_WORKDIR
        ? [
            { path: `${SANDBOX_WORKDIR}/src`, type: "dir" },
            { path: `${SANDBOX_WORKDIR}/package.json`, type: "file" }
          ]
        : [{ path: `${SANDBOX_WORKDIR}/src/App.tsx`, type: "file" }]
    );
    const adapter = new E2BSandboxAdapter({
      sdk: { create: vi.fn(), connect: vi.fn(async () => sandbox) }
    });
    await adapter.connect("sb-test");

    await expect(adapter.listFiles()).resolves.toEqual(["package.json", "src/App.tsx"]);
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
    expect(fetchImpl).toHaveBeenCalledWith("https://sandbox.example.test");
    expect(sandbox.commandsRun[0]?.[0]).toContain("npm run dev -- --host 0.0.0.0 --port 5173");
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
      "pkill -f 'vite.*--port 4173' || true",
      "npm run dev -- --host 0.0.0.0 --port 4173"
    ]);
    expect(sandbox.commandsRun[1]?.[1]).toEqual({ cwd: SANDBOX_WORKDIR, background: true });
  });
});
