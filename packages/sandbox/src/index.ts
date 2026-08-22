import { readdir, readFile as readLocalFile, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Sandbox } from "e2b";

export const SANDBOX_WORKDIR = "/home/user/app";
export const SANDBOX_INSTALL_COMMAND = "npm install --no-audit --no-fund";
export const SANDBOX_BUILD_COMMAND = "npm run build";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxAdapter {
  create(): Promise<string>;
  connect(sandboxId: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
  listFiles(path?: string): Promise<string[]>;
  runCommand(
    command: string,
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<CommandResult>;
  startDevServer(options?: { port?: number }): Promise<void>;
  restartDevServer(options?: { port?: number }): Promise<void>;
  getPreviewUrl(port?: number): Promise<string>;
  kill(sandboxId?: string): Promise<void>;
}

export type SandboxRestoreFile = { path: string; content: string };

export async function ensureSandbox(options: {
  adapter: SandboxAdapter;
  sandboxId?: string | null;
  sandboxExpiresAt?: Date | null;
  snapshotFiles?: SandboxRestoreFile[];
  projectFiles: SandboxRestoreFile[];
  previewPort?: number;
  now?: Date;
}): Promise<{ sandboxId: string; created: boolean; previewUrl?: string }> {
  const now = options.now ?? new Date();
  if (options.sandboxId && options.sandboxExpiresAt && options.sandboxExpiresAt > now) {
    try {
      await options.adapter.connect(options.sandboxId);
      return { sandboxId: options.sandboxId, created: false };
    } catch {
      // Recreate below when E2B no longer has the recorded sandbox.
    }
  }

  const sandboxId = await options.adapter.create();
  for (const file of options.snapshotFiles ?? [])
    await options.adapter.writeFile(file.path, file.content);
  for (const file of options.projectFiles) await options.adapter.writeFile(file.path, file.content);
  const install = await options.adapter.runCommand(SANDBOX_INSTALL_COMMAND, {
    timeoutMs: 120_000
  });
  if (install.exitCode !== 0)
    throw new Error(`Sandbox restore install failed: ${install.stderr || install.stdout}`);
  await options.adapter.startDevServer(
    options.previewPort ? { port: options.previewPort } : undefined
  );
  const previewUrl = await options.adapter.getPreviewUrl(options.previewPort);
  return { sandboxId, created: true, previewUrl };
}

export interface E2BFileSystem {
  write(path: string, data: string): Promise<unknown>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<Array<{ name?: string; path?: string; type?: string }>>;
}

export interface E2BCommands {
  run(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; background?: boolean }
  ): Promise<{
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }>;
}

export interface E2BSandboxClient {
  sandboxId: string;
  files: E2BFileSystem;
  commands: E2BCommands;
  kill(): Promise<void>;
  setTimeout(timeoutMs: number): Promise<void>;
  getHost(port: number): string;
}

export interface E2BSandboxSdk {
  create(options?: { template?: string; timeoutMs?: number }): Promise<E2BSandboxClient>;
  connect(sandboxId: string): Promise<E2BSandboxClient>;
}

export interface E2BAdapterOptions {
  sdk: E2BSandboxSdk;
  templateDir?: string;
  templateId?: string;
  timeoutMs?: number;
  previewPort?: number;
  commandTimeoutMs?: number;
  maxOutputChars?: number;
  fetchImpl?: typeof fetch;
  onProviderCall?: (call: {
    operation: string;
    durationMs: number;
    status: "ok" | "error";
    requestId?: string;
  }) => void;
}

/** Binds the official E2B SDK to the small client surface used by the adapter. */
export function createE2BSandboxSdk(apiKey = process.env.E2B_API_KEY): E2BSandboxSdk {
  return {
    async create(options = {}) {
      const connectionOptions = {
        ...(apiKey ? { apiKey } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
      };
      const sandbox = options.template
        ? await Sandbox.create(options.template, connectionOptions)
        : await Sandbox.create(connectionOptions);
      return sandbox as unknown as E2BSandboxClient;
    },
    async connect(sandboxId) {
      const sandbox = await Sandbox.connect(sandboxId, apiKey ? { apiKey } : undefined);
      return sandbox as unknown as E2BSandboxClient;
    }
  };
}

export function normalizeSandboxPath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0")) {
    throw new Error("Sandbox path must be a non-empty POSIX relative path");
  }
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Sandbox path escapes workspace: ${path}`);
  }
  const result = normalized.split("/").filter(Boolean).join("/");
  if (!result || result === ".") throw new Error("Sandbox path must identify a file or directory");
  return result;
}

function capOutput(value: string | undefined, maxOutputChars: number): string {
  const output = value ?? "";
  return output.length > maxOutputChars
    ? `${output.slice(0, maxOutputChars)}\n[… output truncated …]`
    : output;
}

async function collectTemplateFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name) || entry.name.startsWith(".env"))
        continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
      else if ((await lstat(absolute)).isSymbolicLink())
        throw new Error(`Template contains unsupported symbolic link: ${absolute}`);
    }
  }
  await visit(root);
  return files.sort();
}

export class E2BSandboxAdapter implements SandboxAdapter {
  private sandbox: E2BSandboxClient | undefined;
  private readonly options: Required<
    Pick<E2BAdapterOptions, "timeoutMs" | "previewPort" | "commandTimeoutMs" | "maxOutputChars">
  > &
    E2BAdapterOptions;

  constructor(options: E2BAdapterOptions) {
    this.options = {
      timeoutMs: 15 * 60 * 1000,
      previewPort: 5173,
      commandTimeoutMs: 60 * 1000,
      maxOutputChars: 20_000,
      fetchImpl: fetch,
      ...options
    };
  }

  private requireSandbox(): E2BSandboxClient {
    if (!this.sandbox) throw new Error("Sandbox is not connected");
    return this.sandbox;
  }

  private async observe<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await action();
      this.options.onProviderCall?.({
        operation,
        durationMs: Date.now() - startedAt,
        status: "ok"
      });
      return result;
    } catch (error) {
      const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      const requestId = record.requestId ?? record.request_id;
      this.options.onProviderCall?.({
        operation,
        durationMs: Date.now() - startedAt,
        status: "error",
        ...(typeof requestId === "string" && requestId ? { requestId } : {})
      });
      throw error;
    }
  }

  async create(): Promise<string> {
    const sandbox = await this.observe("sandbox.create", () =>
      this.options.sdk.create({
        ...(this.options.templateId ? { template: this.options.templateId } : {}),
        timeoutMs: this.options.timeoutMs
      })
    );
    this.sandbox = sandbox;
    try {
      const templateDir = this.options.templateDir;
      for (const path of templateDir ? await collectTemplateFiles(resolve(templateDir)) : []) {
        await this.writeFile(
          path,
          await readLocalFile(join(templateDir!, ...path.split("/")), "utf8")
        );
      }
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      this.sandbox = undefined;
      throw error;
    }
    return sandbox.sandboxId;
  }

  async connect(sandboxId: string): Promise<void> {
    this.sandbox = await this.observe("sandbox.connect", () => this.options.sdk.connect(sandboxId));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.observe("files.write", () =>
      this.requireSandbox()
        .files.write(`${SANDBOX_WORKDIR}/${normalizeSandboxPath(path)}`, content)
        .then(() => undefined)
    );
  }

  async readFile(path: string): Promise<string> {
    return this.observe("files.read", () =>
      this.requireSandbox().files.read(`${SANDBOX_WORKDIR}/${normalizeSandboxPath(path)}`)
    );
  }

  async deleteFile(path: string): Promise<void> {
    await this.observe("files.remove", () =>
      this.requireSandbox().files.remove(`${SANDBOX_WORKDIR}/${normalizeSandboxPath(path)}`)
    );
  }

  async listFiles(path = "."): Promise<string[]> {
    const prefix =
      path === "." ? SANDBOX_WORKDIR : `${SANDBOX_WORKDIR}/${normalizeSandboxPath(path)}`;
    const entries = await this.observe("files.list", () =>
      this.requireSandbox().files.list(prefix)
    );
    const files: string[] = [];
    for (const entry of entries) {
      const rawPath = entry.path ?? entry.name ?? "";
      if (!rawPath) continue;
      const relativePath = rawPath.startsWith(`${SANDBOX_WORKDIR}/`)
        ? rawPath.slice(SANDBOX_WORKDIR.length + 1)
        : path === "." || rawPath.startsWith(`${path}/`)
          ? rawPath
          : `${path}/${rawPath}`;
      if (entry.type === "dir" || entry.type === "directory") {
        files.push(...(await this.listFiles(relativePath)));
      } else {
        files.push(relativePath);
      }
    }
    return files.sort();
  }

  async runCommand(
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {}
  ): Promise<CommandResult> {
    let result: { exitCode?: number; stdout?: string; stderr?: string };
    try {
      result = await this.observe("commands.run", () =>
        this.requireSandbox().commands.run(command, {
          cwd: options.cwd
            ? `${SANDBOX_WORKDIR}/${normalizeSandboxPath(options.cwd)}`
            : SANDBOX_WORKDIR,
          timeoutMs: options.timeoutMs ?? this.options.commandTimeoutMs
        })
      );
    } catch (error) {
      const commandError =
        error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
      if (typeof commandError?.exitCode !== "number") throw error;
      result = {
        exitCode: commandError.exitCode,
        stdout: typeof commandError.stdout === "string" ? commandError.stdout : "",
        stderr: typeof commandError.stderr === "string" ? commandError.stderr : ""
      };
    }
    return {
      exitCode: result.exitCode ?? 0,
      stdout: capOutput(result.stdout, this.options.maxOutputChars),
      stderr: capOutput(result.stderr, this.options.maxOutputChars)
    };
  }

  async startDevServer(options: { port?: number } = {}): Promise<void> {
    const port = options.port ?? this.options.previewPort;
    await this.observe("preview.start", () =>
      this.requireSandbox()
        .commands.run(`npm run dev -- --host 0.0.0.0 --port ${port}`, {
          cwd: SANDBOX_WORKDIR,
          background: true
        })
        .then(() => undefined)
    );
  }

  async restartDevServer(options: { port?: number } = {}): Promise<void> {
    const port = options.port ?? this.options.previewPort;
    await this.requireSandbox().commands.run(`pkill -f 'vite.*--port ${port}' || true`, {
      cwd: SANDBOX_WORKDIR,
      timeoutMs: 10_000
    });
    await this.startDevServer({ port });
  }

  async getPreviewUrl(port = this.options.previewPort): Promise<string> {
    return this.observe("preview.health", async () => {
      const host = this.requireSandbox().getHost(port);
      const url = /^https?:\/\//i.test(host) ? host : `https://${host}`;
      const deadline = Date.now() + this.options.commandTimeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const response = await (this.options.fetchImpl ?? fetch)(url);
          if (response.ok) return url;
          lastError = new Error(`Preview returned HTTP ${response.status}`);
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      throw new Error(`Preview did not become healthy before timeout: ${String(lastError)}`);
    });
  }

  async kill(sandboxId?: string): Promise<void> {
    await this.observe("sandbox.kill", async () => {
      if (sandboxId && this.sandbox?.sandboxId !== sandboxId) {
        await (await this.options.sdk.connect(sandboxId)).kill();
        return;
      }
      if (this.sandbox) await this.sandbox.kill();
      this.sandbox = undefined;
    });
  }
}
