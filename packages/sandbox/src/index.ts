import { readdir, readFile as readLocalFile, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { FileNotFoundError, Sandbox } from "e2b";

export const SANDBOX_WORKDIR = "/home/user/app";
export const SANDBOX_INSTALL_COMMAND = "npm install --no-audit --no-fund";
export const SANDBOX_BUILD_COMMAND = "npm run build";
const SANDBOX_PREVIEW_SERVER_PATH = "/tmp/atom-replica-preview.mjs";
const SANDBOX_IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", ".vite", "coverage"]);

export const sandboxLifecycleErrorCodes = {
  SANDBOX_RECONNECT_FAILED: "SANDBOX_RECONNECT_FAILED",
  SANDBOX_TTL_RENEWAL_FAILED: "SANDBOX_TTL_RENEWAL_FAILED",
  SANDBOX_ENV_READY_FAILED: "SANDBOX_ENV_READY_FAILED",
  SANDBOX_CREATE_FAILED: "SANDBOX_CREATE_FAILED",
  SANDBOX_TEMPLATE_FAILED: "SANDBOX_TEMPLATE_FAILED",
  SANDBOX_RESTORE_FILES_FAILED: "SANDBOX_RESTORE_FILES_FAILED",
  SANDBOX_RESTORE_INSTALL_FAILED: "SANDBOX_RESTORE_INSTALL_FAILED",
  SANDBOX_RESTORE_BUILD_FAILED: "SANDBOX_RESTORE_BUILD_FAILED",
  PREVIEW_PREPARE_FAILED: "PREVIEW_PREPARE_FAILED",
  PREVIEW_STOP_FAILED: "PREVIEW_STOP_FAILED",
  PREVIEW_REMOVE_FAILED: "PREVIEW_REMOVE_FAILED",
  PREVIEW_START_FAILED: "PREVIEW_START_FAILED",
  PREVIEW_HEALTH_FAILED: "PREVIEW_HEALTH_FAILED"
} as const;

export type SandboxLifecycleErrorCode =
  (typeof sandboxLifecycleErrorCodes)[keyof typeof sandboxLifecycleErrorCodes];

export class SandboxLifecycleError extends Error {
  constructor(
    readonly code: SandboxLifecycleErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SandboxLifecycleError";
  }
}

async function sandboxStage<T>(
  code: SandboxLifecycleErrorCode,
  message: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SandboxLifecycleError) throw error;
    throw new SandboxLifecycleError(code, message, { cause: error });
  }
}

async function retrySandboxStage<T>(
  code: SandboxLifecycleErrorCode,
  message: string,
  operation: () => Promise<T>,
  attempts = 10
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
    }
  }
  throw new SandboxLifecycleError(code, message, { cause: lastError });
}
export const SANDBOX_PREVIEW_SERVER_SOURCE = `import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const port = Number(process.argv[2]);
const root = resolve(process.cwd(), "dist");
const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2" };

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://preview.local").pathname);
    let file = resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + sep)) throw new Error("invalid path");
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      file = resolve(file, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) {
      file = resolve(root, "index.html");
      info = await stat(file);
    }
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": info.size,
      "Content-Type": types[extname(file).toLowerCase()] ?? "application/octet-stream"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "0.0.0.0", () => console.log("Preview listening on 0.0.0.0:" + port));
`;

export function sandboxPreviewCommand(port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("Sandbox Preview port must be an integer between 1024 and 65535");
  return `node ${SANDBOX_PREVIEW_SERVER_PATH} ${port}`;
}

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
  let recoveryFrom: SandboxLifecycleErrorCode | undefined;
  if (options.sandboxId && options.sandboxExpiresAt && options.sandboxExpiresAt > now) {
    try {
      await options.adapter.connect(options.sandboxId);
      return { sandboxId: options.sandboxId, created: false };
    } catch (error) {
      recoveryFrom =
        error instanceof SandboxLifecycleError
          ? error.code
          : sandboxLifecycleErrorCodes.SANDBOX_RECONNECT_FAILED;
      // Recreate below when E2B no longer has the recorded sandbox.
    }
  }

  const recoverySuffix = recoveryFrom ? ` after ${recoveryFrom}` : "";
  const sandboxId = await sandboxStage(
    sandboxLifecycleErrorCodes.SANDBOX_CREATE_FAILED,
    `Could not create a replacement Sandbox${recoverySuffix}.`,
    () => options.adapter.create()
  );
  await sandboxStage(
    sandboxLifecycleErrorCodes.SANDBOX_RESTORE_FILES_FAILED,
    "Could not restore the saved project files into the Sandbox.",
    async () => {
      for (const file of options.snapshotFiles ?? [])
        await options.adapter.writeFile(file.path, file.content);
      for (const file of options.projectFiles)
        await options.adapter.writeFile(file.path, file.content);
    }
  );
  const install = await sandboxStage(
    sandboxLifecycleErrorCodes.SANDBOX_RESTORE_INSTALL_FAILED,
    "Could not install dependencies while restoring the Sandbox.",
    () =>
      options.adapter.runCommand(SANDBOX_INSTALL_COMMAND, {
        timeoutMs: 120_000
      })
  );
  if (install.exitCode !== 0)
    throw new SandboxLifecycleError(
      sandboxLifecycleErrorCodes.SANDBOX_RESTORE_INSTALL_FAILED,
      `Sandbox dependency restore exited with code ${install.exitCode}.`
    );
  const build = await sandboxStage(
    sandboxLifecycleErrorCodes.SANDBOX_RESTORE_BUILD_FAILED,
    "Could not build the restored project.",
    () =>
      options.adapter.runCommand(SANDBOX_BUILD_COMMAND, {
        timeoutMs: 120_000
      })
  );
  if (build.exitCode !== 0)
    throw new SandboxLifecycleError(
      sandboxLifecycleErrorCodes.SANDBOX_RESTORE_BUILD_FAILED,
      `Sandbox restore build exited with code ${build.exitCode}.`
    );
  await sandboxStage(
    sandboxLifecycleErrorCodes.PREVIEW_START_FAILED,
    "Could not start the restored Preview process.",
    () =>
      options.adapter.startDevServer(
        options.previewPort ? { port: options.previewPort } : undefined
      )
  );
  const previewUrl = await sandboxStage(
    sandboxLifecycleErrorCodes.PREVIEW_HEALTH_FAILED,
    "The restored Preview did not become healthy.",
    () => options.adapter.getPreviewUrl(options.previewPort)
  );
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
    options?: {
      cwd?: string;
      timeoutMs?: number;
      background?: boolean;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    }
  ): Promise<{
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    wait?: () => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  }>;
}

export interface E2BSandboxClient {
  sandboxId: string;
  files: E2BFileSystem;
  commands: E2BCommands;
  kill(): Promise<void>;
  setTimeout(timeoutMs: number, options?: { requestTimeoutMs?: number }): Promise<void>;
  isRunning(options?: { requestTimeoutMs?: number }): Promise<boolean>;
  getHost(port: number): string;
}

export interface E2BSandboxSdk {
  create(options?: { template?: string; timeoutMs?: number }): Promise<E2BSandboxClient>;
  connect(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<E2BSandboxClient>;
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
    async connect(sandboxId, options = {}) {
      const sandbox = await Sandbox.connect(sandboxId, {
        ...(apiKey ? { apiKey } : {}),
        ...options
      });
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
  private previewProcessAttempt = 0;
  private previewProcessState = "not started";
  private previewProcessOutput = "";
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
    const sandbox = await sandboxStage(
      sandboxLifecycleErrorCodes.SANDBOX_CREATE_FAILED,
      "Could not create the E2B Sandbox.",
      () =>
        this.observe("sandbox.create", () =>
          this.options.sdk.create({
            ...(this.options.templateId ? { template: this.options.templateId } : {}),
            timeoutMs: this.options.timeoutMs
          })
        )
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
      throw new SandboxLifecycleError(
        sandboxLifecycleErrorCodes.SANDBOX_TEMPLATE_FAILED,
        "Could not prepare the fixed Sandbox template.",
        { cause: error }
      );
    }
    return sandbox.sandboxId;
  }

  async connect(sandboxId: string): Promise<void> {
    const sandbox = await sandboxStage(
      sandboxLifecycleErrorCodes.SANDBOX_RECONNECT_FAILED,
      "Could not reconnect to the existing E2B Sandbox.",
      () =>
        this.observe("sandbox.connect", () =>
          this.options.sdk.connect(sandboxId, {
            requestTimeoutMs: this.options.commandTimeoutMs
          })
        )
    );
    await sandboxStage(
      sandboxLifecycleErrorCodes.SANDBOX_TTL_RENEWAL_FAILED,
      "Could not renew the E2B Sandbox lifetime.",
      () =>
        this.observe("sandbox.extend_timeout", () =>
          sandbox.setTimeout(this.options.timeoutMs, {
            requestTimeoutMs: this.options.commandTimeoutMs
          })
        )
    );
    await sandboxStage(
      sandboxLifecycleErrorCodes.SANDBOX_ENV_READY_FAILED,
      "The reconnected E2B Sandbox did not become ready.",
      async () => {
        const deadline = Date.now() + this.options.commandTimeoutMs;
        while (Date.now() < deadline) {
          const remaining = Math.max(1, deadline - Date.now());
          try {
            if (
              await sandbox.isRunning({
                requestTimeoutMs: Math.min(10_000, remaining)
              })
            )
              return;
          } catch {
            // The control plane can return before the Sandbox environment becomes ready.
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }
        throw new Error("Sandbox environment readiness timed out.");
      }
    );
    this.sandbox = sandbox;
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
      const segments = relativePath.split("/");
      const name = segments.at(-1) ?? "";
      if (
        segments.some((segment) => SANDBOX_IGNORED_SEGMENTS.has(segment)) ||
        name === ".env" ||
        name.startsWith(".env.")
      )
        continue;
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
    const attempt = ++this.previewProcessAttempt;
    this.previewProcessState = "starting";
    this.previewProcessOutput = "";
    const captureOutput = (data: string) => {
      this.previewProcessOutput = capOutput(
        `${this.previewProcessOutput}${data}`,
        Math.min(this.options.maxOutputChars, 2_000)
      );
    };
    await sandboxStage(
      sandboxLifecycleErrorCodes.PREVIEW_STOP_FAILED,
      "Could not stop the previous Preview process.",
      () =>
        this.requireSandbox().commands.run(
          `pkill -f '/tmp/[a]tom-replica-preview.mjs ${port}' || true`,
          { cwd: SANDBOX_WORKDIR, timeoutMs: 10_000 }
        )
    );
    await sandboxStage(
      sandboxLifecycleErrorCodes.PREVIEW_REMOVE_FAILED,
      "Could not remove the previous Preview launcher.",
      async () => {
        try {
          await this.requireSandbox().files.remove(SANDBOX_PREVIEW_SERVER_PATH);
        } catch (error) {
          const record =
            error && typeof error === "object" ? (error as Record<string, unknown>) : {};
          if (!(error instanceof FileNotFoundError) && record.name !== "FileNotFoundError")
            throw error;
        }
      }
    );
    await retrySandboxStage(
      sandboxLifecycleErrorCodes.PREVIEW_PREPARE_FAILED,
      "Could not prepare the Preview server.",
      () =>
        this.observe("preview.prepare", () =>
          this.requireSandbox()
            .files.write(SANDBOX_PREVIEW_SERVER_PATH, SANDBOX_PREVIEW_SERVER_SOURCE)
            .then(() => undefined)
        )
    );
    const process = await sandboxStage(
      sandboxLifecycleErrorCodes.PREVIEW_START_FAILED,
      "Could not start the Preview process.",
      () =>
        this.observe("preview.start", () =>
          this.requireSandbox().commands.run(sandboxPreviewCommand(port), {
            cwd: SANDBOX_WORKDIR,
            background: true,
            onStdout: captureOutput,
            onStderr: captureOutput
          })
        )
    );
    this.previewProcessState = "running";
    if (typeof process.wait === "function") {
      void process.wait().then(
        (result) => {
          if (attempt !== this.previewProcessAttempt) return;
          captureOutput(result.stdout ?? "");
          captureOutput(result.stderr ?? "");
          this.previewProcessState = `exited with code ${result.exitCode ?? "unknown"}`;
        },
        (error) => {
          if (attempt !== this.previewProcessAttempt) return;
          const record =
            error && typeof error === "object" ? (error as Record<string, unknown>) : {};
          captureOutput(typeof record.stderr === "string" ? record.stderr : "");
          captureOutput(typeof record.stdout === "string" ? record.stdout : "");
          this.previewProcessState = `exited with code ${typeof record.exitCode === "number" ? record.exitCode : "unknown"}`;
        }
      );
    }
  }

  async restartDevServer(options: { port?: number } = {}): Promise<void> {
    const port = options.port ?? this.options.previewPort;
    await this.startDevServer({ port });
  }

  async getPreviewUrl(port = this.options.previewPort): Promise<string> {
    return sandboxStage(
      sandboxLifecycleErrorCodes.PREVIEW_HEALTH_FAILED,
      "The Preview did not become healthy.",
      () =>
        this.observe("preview.health", async () => {
          const host = this.requireSandbox().getHost(port);
          const url = /^https?:\/\//i.test(host) ? host : `https://${host}`;
          const deadline = Date.now() + this.options.commandTimeoutMs;
          let lastError: unknown;
          while (Date.now() < deadline) {
            try {
              const response = await (this.options.fetchImpl ?? fetch)(url, {
                headers: { "Cache-Control": "no-cache" },
                signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now())))
              });
              if (response.ok) return url;
              lastError = new Error(`Preview returned HTTP ${response.status}`);
            } catch (error) {
              lastError = error;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
          }
          let localProbe = "unavailable";
          try {
            const result = await this.requireSandbox().commands.run(
              `node -e "fetch('http://127.0.0.1:${port}').then(r=>{console.log('HTTP '+r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.cause?.code||e.message);process.exit(1)})"`,
              { cwd: SANDBOX_WORKDIR, timeoutMs: 10_000 }
            );
            localProbe = capOutput(
              (result.stdout || result.stderr || `exit ${result.exitCode ?? "unknown"}`).trim(),
              300
            );
          } catch (error) {
            const record =
              error && typeof error === "object" ? (error as Record<string, unknown>) : {};
            localProbe = capOutput(
              String(record.stderr ?? record.stdout ?? record.message ?? "probe failed").trim(),
              300
            );
          }
          const processOutput = this.previewProcessOutput.trim()
            ? ` Output: ${this.previewProcessOutput.trim()}`
            : "";
          throw new Error(
            `Preview did not become healthy before timeout: ${String(lastError)}. ` +
              `Sandbox-local probe: ${localProbe || "no output"}. ` +
              `Preview process: ${this.previewProcessState}.${processOutput}`
          );
        })
    );
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
