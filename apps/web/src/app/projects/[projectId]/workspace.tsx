"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileCode2,
  FileJson2,
  Folder,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  TerminalSquare,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  activityFromRunEvent,
  initialProgressForStatus,
  progressFromRunEvent,
  type ActivityItem,
  type RunStreamEvent
} from "./workspace-activity";

type WorkspaceProps = {
  projectId: string;
  projectName: string;
  initialPreviewUrl?: string | undefined;
  initialRunStatus?: string | undefined;
  initialRunErrorCode?: string | undefined;
  initialRunErrorMessage?: string | undefined;
  initialFiles?: Array<{ path: string; version: number; updatedAt: Date }>;
  runId?: string | undefined;
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system_event";
    content: string;
    createdAt: Date;
  }>;
};

type ViewMode = "preview" | "editor";
type RunStatus =
  "queued" | "planning" | "coding" | "validating" | "running" | "failed" | "cancelled";

// A cold Sandbox restore may spend up to two command-timeout windows installing dependencies and
// waiting for the public Preview. Keep the browser alive long enough to receive that valid result.
const RUNTIME_JOB_TIMEOUT_MS = 6 * 60_000;

function FileIcon({ kind }: { kind: "folder" | "json" | "tsx" | "html" | "css" }) {
  if (kind === "folder") return <Folder className="h-4 w-4 text-violet-500" />;
  if (kind === "json") return <FileJson2 className="h-4 w-4 text-amber-500" />;
  return <FileCode2 className="h-4 w-4 text-sky-500" />;
}

export function Workspace({
  projectId,
  projectName,
  initialPreviewUrl,
  initialRunStatus,
  initialRunErrorCode,
  initialRunErrorMessage,
  initialFiles = [],
  runId,
  messages = []
}: WorkspaceProps) {
  const router = useRouter();
  const fileSummaries = initialFiles.map((file) => ({
    ...file,
    kind: file.path.endsWith(".json") ? ("json" as const) : ("tsx" as const)
  }));
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [files, setFiles] = useState(fileSummaries);
  const [selectedFile, setSelectedFile] = useState(fileSummaries[0]?.path ?? "src/App.tsx");
  const [expanded, setExpanded] = useState(true);
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileVersion, setFileVersion] = useState(1);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sentPrompt, setSentPrompt] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState(runId);
  const [runStatus, setRunStatus] = useState<RunStatus>(
    initialRunStatus === "queued" ||
      initialRunStatus === "planning" ||
      initialRunStatus === "coding" ||
      initialRunStatus === "validating" ||
      initialRunStatus === "failed" ||
      initialRunStatus === "cancelled"
      ? initialRunStatus
      : "running"
  );
  const [previewUrl, setPreviewUrl] = useState(initialPreviewUrl);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(
    initialRunErrorCode || initialRunErrorMessage
      ? {
          code: initialRunErrorCode ?? "INTERNAL_ERROR",
          message: initialRunErrorMessage ?? "The run did not complete."
        }
      : null
  );
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<ActivityItem[]>([]);
  const [runProgress, setRunProgress] = useState(() => initialProgressForStatus(initialRunStatus));
  const [planSummary, setPlanSummary] = useState("Implementation plan");
  const [planSteps, setPlanSteps] = useState([
    "Understand your idea",
    "Prepare project files",
    "Validate the preview"
  ]);
  const seenEventIds = useRef(new Set<number>());
  const localActivityId = useRef(0);

  useEffect(() => setIsHydrated(true), []);

  function addLocalActivity(title: string, detail?: string, tone: ActivityItem["tone"] = "info") {
    localActivityId.current += 1;
    setLiveEvents((current) => [
      ...current,
      { id: `local-${localActivityId.current}`, title, ...(detail ? { detail } : {}), tone }
    ]);
  }

  useEffect(() => {
    if (!currentRunId) return;

    const source = new EventSource(`/api/runs/${currentRunId}/events`);
    const eventTypes = [
      "run.queued",
      "run.planning",
      "run.coding",
      "run.validating",
      "stage.progress",
      "plan.created",
      "step.started",
      "assistant.delta",
      "tool.started",
      "tool.completed",
      "command.output",
      "validation.failed",
      "preview.ready",
      "file.created",
      "file.updated",
      "file.deleted",
      "run.completed",
      "run.failed",
      "run.cancelled"
    ];
    const listeners = eventTypes.map((type) => {
      const listener = (event: Event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as RunStreamEvent;
        if (seenEventIds.current.has(data.eventId)) return;
        seenEventIds.current.add(data.eventId);
        const activity = activityFromRunEvent(data);
        if (activity) setLiveEvents((current) => [...current, activity]);
        setRunProgress((current) => progressFromRunEvent(current, data));
        if (data.type === "plan.created") {
          if (data.payload?.summary) setPlanSummary(data.payload.summary);
          if (data.payload?.steps?.length) setPlanSteps(data.payload.steps);
        }
        if (data.type === "run.planning") setRunStatus("planning");
        if (data.type === "run.coding") setRunStatus("coding");
        if (data.type === "run.validating") setRunStatus("validating");
        if (data.type === "preview.ready" && data.payload?.url) {
          setPreviewUrl(data.payload.url);
          setRunStatus("running");
        }
        if (data.type === "run.completed") {
          setRunStatus("running");
          setSentPrompt(null);
          void refreshFiles();
          router.refresh();
          setFailure(null);
        }
        if (["file.created", "file.updated", "file.deleted"].includes(data.type)) {
          void refreshFiles();
        }
        if (data.type === "run.failed") {
          setRunStatus("failed");
          void refreshFiles();
          if (sentPrompt) setRetryPrompt(sentPrompt);
          setSentPrompt(null);
          setFailure({
            code: data.payload?.code ?? "INTERNAL_ERROR",
            message: data.payload?.message ?? "The run failed."
          });
        }
        if (data.type === "run.cancelled") {
          setRunStatus("cancelled");
          if (sentPrompt) setRetryPrompt(sentPrompt);
          setSentPrompt(null);
          setFailure({ code: "RUN_CANCELLED", message: data.payload?.message ?? "Run cancelled." });
        }
      };
      source.addEventListener(type, listener);
      return { type, listener };
    });

    return () => {
      listeners.forEach(({ type, listener }) => source.removeEventListener(type, listener));
      source.close();
    };
  }, [currentRunId]);

  async function refreshFiles() {
    const response = await fetch(`/api/projects/${projectId}/files`);
    const body = (await response.json()) as {
      files?: Array<{ path: string; version: number; updatedAt: string }>;
    };
    if (!response.ok || !body.files) return;
    setFiles(
      body.files.map((file) => ({
        ...file,
        updatedAt: new Date(file.updatedAt),
        kind: file.path.endsWith(".json") ? ("json" as const) : ("tsx" as const)
      }))
    );
  }

  async function selectFile(path: string) {
    const response = await fetch(
      `/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`
    );
    const file = (await response.json()) as { content?: string; version?: number; error?: string };
    if (!response.ok || file.content === undefined || file.version === undefined) {
      setEditorError(file.error ?? "Unable to load file.");
      return;
    }
    setSelectedFile(path);
    setFileContent(file.content);
    setSavedContent(file.content);
    setFileVersion(file.version);
    setEditorError(null);
    setViewMode("editor");
  }

  function openEditor() {
    const file = files.find((item) => item.path === selectedFile) ?? files[0];
    if (file) {
      void selectFile(file.path);
      return;
    }
    setEditorError("No generated source files are available yet.");
    setViewMode("editor");
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (
      !nextPrompt ||
      isSaving ||
      isRestarting ||
      fileContent !== savedContent ||
      ["queued", "planning", "coding", "validating"].includes(runStatus)
    )
      return;
    await queuePrompt(nextPrompt);
  }

  async function queuePrompt(nextPrompt: string) {
    const response = await fetch(`/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: nextPrompt })
    });
    const body = (await response.json()) as { runId?: string; error?: string; code?: string };
    if (!response.ok || !body.runId) {
      addLocalActivity(
        "Unable to queue request",
        body.error ?? "Unable to queue message.",
        "error"
      );
      if (body.code) setFailure({ code: body.code, message: body.error ?? "Request failed." });
      setRetryPrompt(nextPrompt);
      return;
    }
    setSentPrompt(nextPrompt);
    setPrompt("");
    seenEventIds.current.clear();
    setLiveEvents([]);
    setCurrentRunId(body.runId);
    setRunStatus("queued");
    setRunProgress(initialProgressForStatus("queued"));
    setFailure(null);
    setRetryPrompt(null);
  }

  async function retryRun() {
    const lastPrompt =
      retryPrompt ??
      sentPrompt ??
      [...messages].reverse().find((message) => message.role === "user")?.content;
    if (!lastPrompt || ["queued", "planning", "coding", "validating"].includes(runStatus)) return;
    await queuePrompt(lastPrompt);
  }

  async function cancelRun() {
    if (!currentRunId || !["queued", "planning", "coding", "validating"].includes(runStatus))
      return;
    setIsCancelling(true);
    try {
      const response = await fetch(`/api/runs/${currentRunId}/cancel`, { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to cancel run.");
    } catch (error) {
      addLocalActivity(
        "Unable to cancel run",
        error instanceof Error ? error.message : "Unable to cancel run.",
        "error"
      );
    } finally {
      setIsCancelling(false);
    }
  }

  async function waitForRuntimeJob(runtimeJobId: string) {
    const deadline = Date.now() + RUNTIME_JOB_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/runtime-jobs/${runtimeJobId}`, { cache: "no-store" });
      const job = (await response.json()) as {
        status?: "queued" | "processing" | "completed" | "failed";
        resultJson?: { previewUrl?: string | null };
        errorCode?: string | null;
        errorMessage?: string | null;
        error?: string;
      };
      if (!response.ok) throw new Error(job.error ?? "Unable to check runtime operation.");
      if (job.status === "completed") return job.resultJson ?? {};
      if (job.status === "failed")
        throw new Error(
          [job.errorCode, job.errorMessage ?? "Runtime operation failed."]
            .filter(Boolean)
            .join(": ")
        );
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error("Runtime operation timed out. The Worker may be unavailable.");
  }

  async function saveFile() {
    setIsSaving(true);
    setEditorError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: fileContent, version: fileVersion })
      });
      const body = (await response.json()) as {
        content?: string;
        version?: number;
        current?: { content: string; version: number };
        runtimeJobId?: string;
        error?: string;
      };
      if (!response.ok) {
        if (body.current) {
          setFileContent(body.current.content);
          setSavedContent(body.current.content);
          setFileVersion(body.current.version);
        }
        throw new Error(body.error ?? "Unable to save file.");
      }
      setSavedContent(body.content ?? fileContent);
      setFileVersion(body.version ?? fileVersion + 1);
      if (!body.runtimeJobId)
        throw new Error("File saved but runtime synchronization was not queued.");
      const result = await waitForRuntimeJob(body.runtimeJobId);
      if (result.previewUrl) setPreviewUrl(result.previewUrl);
      addLocalActivity("File synchronized to Preview", selectedFile, "success");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Unable to save file.");
    } finally {
      setIsSaving(false);
    }
  }

  async function restartPreview() {
    setIsRestarting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/runtime/restart`, {
        method: "POST"
      });
      const body = (await response.json()) as { runtimeJobId?: string; error?: string };
      if (!response.ok || !body.runtimeJobId)
        throw new Error(body.error ?? "Preview restart failed.");
      const result = await waitForRuntimeJob(body.runtimeJobId);
      if (!result.previewUrl) throw new Error("Preview restart completed without a URL.");
      setPreviewUrl(result.previewUrl);
      setRunStatus("running");
      addLocalActivity("Preview restarted", result.previewUrl, "success");
    } catch (error) {
      addLocalActivity(
        "Preview restart failed",
        error instanceof Error ? error.message : "Preview restart failed.",
        "error"
      );
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-[#f8f8fa] text-zinc-900">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            aria-label="Back to projects"
            className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            onClick={() => router.push("/projects")}
            type="button"
          >
            <X className="h-4 w-4 rotate-45" />
          </button>
          <div className="h-5 w-px bg-zinc-200" />
          <Link
            className="hidden items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 sm:flex"
            href="/projects"
          >
            <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
          </Link>
          <div className="h-5 w-px bg-zinc-200" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{projectName}</p>
            <p className="font-mono text-[10px] text-zinc-400">{projectId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium sm:flex ${runStatus === "failed" ? "bg-red-50 text-red-700" : runStatus === "cancelled" ? "bg-zinc-100 text-zinc-600" : runStatus === "running" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
          >
            {["queued", "planning", "coding", "validating"].includes(runStatus) ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {runStatus === "queued"
              ? `Queued · ${runProgress.percent}%`
              : runStatus === "planning"
                ? `Planning · ${runProgress.percent}%`
                : runStatus === "coding"
                  ? `Coding · ${runProgress.percent}%`
                  : runStatus === "validating"
                    ? `Validating · ${runProgress.percent}%`
                    : runStatus === "failed"
                      ? "Failed"
                      : runStatus === "cancelled"
                        ? "Cancelled"
                        : "Running"}
          </span>
          {["queued", "planning", "coding", "validating"].includes(runStatus) ? (
            <button
              className="hidden items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 sm:flex"
              disabled={isCancelling}
              onClick={cancelRun}
              type="button"
            >
              <Square className="h-3 w-3 fill-current" />
              {isCancelling ? "Cancelling" : "Cancel"}
            </button>
          ) : null}
          <button
            className="hidden items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 sm:flex"
            data-runtime-ready={isHydrated ? "true" : "false"}
            disabled={!isHydrated || isRestarting}
            onClick={restartPreview}
            type="button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRestarting ? "animate-spin" : ""}`} />
            {isRestarting ? "Restarting" : "Restart"}
          </button>
          <a
            className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
            href={`/api/projects/${projectId}/download`}
          >
            <Download className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Download</span>
          </a>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[310px_220px_minmax(0,1fr)]">
        <aside className="flex min-h-[430px] flex-col border-b border-zinc-200 bg-white lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquare className="h-4 w-4 text-violet-600" /> Activity
            </div>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">
              Run {currentRunId?.slice(0, 8) ?? "pending"}
            </span>
          </div>
          <div className="flex-1 space-y-5 overflow-auto p-5">
            <section
              aria-label="Generation progress"
              className="rounded-xl border border-violet-100 bg-violet-50/60 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-violet-950">{runProgress.title}</p>
                  {runProgress.detail ? (
                    <p className="mt-1 text-[11px] leading-4 text-violet-700">
                      {runProgress.detail}
                    </p>
                  ) : null}
                </div>
                <span className="font-mono text-[11px] font-semibold text-violet-700">
                  {runProgress.percent}%
                </span>
              </div>
              <div
                aria-label={`${runProgress.percent}% complete`}
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-violet-100"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={runProgress.percent}
              >
                <div
                  className={`h-full rounded-full transition-all duration-500 ${runProgress.stage === "failed" || runProgress.stage === "cancelled" ? "bg-red-500" : runProgress.percent === 100 ? "bg-emerald-500" : "bg-violet-600"}`}
                  style={{ width: `${runProgress.percent}%` }}
                />
              </div>
            </section>
            {messages.length > 0 ? (
              messages.map((message) => (
                <div className="flex gap-3" key={message.id}>
                  <div
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${message.role === "user" ? "bg-zinc-900 text-white" : "bg-violet-100 text-violet-600"}`}
                  >
                    {message.role === "user" ? "You" : <Sparkles className="h-4 w-4" />}
                  </div>
                  <div
                    className={`min-w-0 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-sm ${message.role === "user" ? "bg-zinc-100 text-zinc-700" : "bg-violet-50 text-violet-800"}`}
                  >
                    {message.content}
                  </div>
                </div>
              ))
            ) : (
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[10px] font-bold text-white">
                  You
                </div>
                <div className="min-w-0 rounded-2xl rounded-tl-sm bg-zinc-100 px-3.5 py-2.5 text-sm text-zinc-700">
                  Start building {projectName}
                </div>
              </div>
            )}
            <div className="relative flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="space-y-3 text-sm">
                <p className="font-medium text-zinc-800">{planSummary}</p>
                <div className="space-y-2 text-xs text-zinc-500">
                  {planSteps.map((step) => (
                    <p className="flex items-center gap-2" key={step}>
                      {runProgress.percent === 100 ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <span className="h-3.5 w-3.5 rounded-full border border-zinc-300" />
                      )}
                      {step}
                    </p>
                  ))}
                </div>
              </div>
            </div>
            {sentPrompt ? (
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[10px] font-bold text-white">
                  You
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-zinc-100 px-3.5 py-2.5 text-sm text-zinc-700">
                  {sentPrompt}
                </div>
              </div>
            ) : null}
            {liveEvents.map((event) => (
              <div className="flex gap-3" key={event.id}>
                <div
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${event.tone === "success" ? "bg-emerald-100 text-emerald-700" : event.tone === "error" ? "bg-red-100 text-red-700" : "bg-violet-100 text-violet-600"}`}
                >
                  {event.tone === "success" ? (
                    <Check className="h-4 w-4" />
                  ) : event.tone === "error" ? (
                    <X className="h-4 w-4" />
                  ) : event.tone === "working" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                </div>
                <div
                  className={`min-w-0 rounded-2xl rounded-tl-sm px-3.5 py-2.5 ${event.tone === "error" ? "bg-red-50 text-red-800" : event.tone === "success" ? "bg-emerald-50 text-emerald-900" : "bg-violet-50 text-violet-900"}`}
                >
                  <p className="text-xs font-semibold">{event.title}</p>
                  {event.detail ? (
                    <p className="mt-1 break-words font-mono text-[10px] leading-4 opacity-75">
                      {event.detail}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
            {failure ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <p className="font-semibold">{failure.code.replaceAll("_", " ")}</p>
                <p className="mt-1 leading-5 text-red-700">{failure.message}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {failure.code !== "RATE_LIMITED" ? (
                    <button
                      className="rounded-lg bg-red-700 px-2.5 py-1.5 font-semibold text-white hover:bg-red-800"
                      onClick={retryRun}
                      type="button"
                    >
                      Retry run
                    </button>
                  ) : null}
                  {failure.code === "SANDBOX_FAILED" ? (
                    <button
                      className="rounded-lg border border-red-300 px-2.5 py-1.5 font-semibold hover:bg-red-100"
                      onClick={restartPreview}
                      type="button"
                    >
                      Restart preview
                    </button>
                  ) : null}
                  <button
                    className="rounded-lg border border-red-300 px-2.5 py-1.5 font-semibold hover:bg-red-100"
                    onClick={() => setFailure(null)}
                    type="button"
                  >
                    Continue chatting
                  </button>
                  <a
                    className="rounded-lg border border-red-300 px-2.5 py-1.5 font-semibold hover:bg-red-100"
                    href={`/api/projects/${projectId}/download`}
                  >
                    Download code
                  </a>
                </div>
              </div>
            ) : null}
          </div>
          <form className="border-t border-zinc-100 p-4" onSubmit={submitPrompt}>
            {fileContent !== savedContent ? (
              <p className="mb-2 text-xs text-amber-700">
                Save or discard editor changes before asking the Agent.
              </p>
            ) : null}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2 focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100">
              <textarea
                className="min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-zinc-400"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Ask for a change…"
                value={prompt}
              />
              <div className="flex justify-end">
                <button
                  aria-label="Send message"
                  className="rounded-lg bg-zinc-900 p-2 text-white hover:bg-violet-700 disabled:opacity-40"
                  disabled={
                    !prompt.trim() ||
                    isSaving ||
                    isRestarting ||
                    fileContent !== savedContent ||
                    ["queued", "planning", "coding", "validating"].includes(runStatus)
                  }
                  type="submit"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </form>
        </aside>

        <aside className="hidden border-r border-zinc-200 bg-[#fbfbfc] lg:block">
          <div className="flex items-center border-b border-zinc-100 px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Code2 className="h-4 w-4 text-zinc-500" /> Files
            </div>
          </div>
          <div className="p-2 text-sm">
            <button
              className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left font-medium hover:bg-zinc-100"
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}{" "}
              <FolderOpen className="h-4 w-4 text-violet-500" /> app
            </button>
            {expanded ? (
              <div className="ml-3 border-l border-zinc-200 pl-2">
                {files.length ? (
                  files.map((file) => (
                    <button
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${selectedFile === file.path ? "bg-violet-50 font-medium text-violet-700" : "text-zinc-600 hover:bg-zinc-100"}`}
                      key={file.path}
                      onClick={() => selectFile(file.path)}
                      type="button"
                    >
                      <FileIcon kind={file.kind} />
                      {file.path.includes("/") ? file.path.split("/").pop() : file.path}
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-3 text-xs leading-5 text-zinc-400">
                    No generated files yet. Files will appear here as the Agent writes them.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </aside>

        <section className="flex min-h-[560px] min-w-0 flex-col bg-white lg:min-h-0">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <div className="flex rounded-lg bg-zinc-100 p-1 text-xs font-medium">
              <button
                className={`rounded-md px-3 py-1.5 ${viewMode === "preview" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
                onClick={() => setViewMode("preview")}
                type="button"
              >
                <Play className="mr-1.5 inline h-3.5 w-3.5" />
                Preview
              </button>
              <button
                className={`rounded-md px-3 py-1.5 ${viewMode === "editor" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}
                onClick={openEditor}
                type="button"
              >
                <Code2 className="mr-1.5 inline h-3.5 w-3.5" />
                Editor
              </button>
            </div>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <TerminalSquare className="h-3.5 w-3.5" /> Sandbox preview
            </span>
          </div>
          {viewMode === "preview" ? (
            <div className="flex flex-1 items-center justify-center bg-[#f4f4f6] p-8">
              <div className="flex h-full min-h-[400px] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
                <div className="flex h-9 items-center gap-1.5 border-b border-zinc-100 px-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                  <div className="ml-3 flex-1 rounded bg-zinc-50 px-3 py-1 text-[10px] text-zinc-400">
                    {previewUrl ?? "Preview will be available when generation starts"}
                  </div>
                </div>
                {previewUrl ? (
                  <iframe
                    className="h-full min-h-[400px] w-full flex-1 bg-white"
                    sandbox="allow-scripts allow-forms allow-modals allow-popups"
                    src={previewUrl}
                    title={`${projectName} preview`}
                  />
                ) : (
                  <div className="grid flex-1 place-items-center p-8 text-center">
                    <div>
                      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
                        <Sparkles className="h-7 w-7" />
                      </div>
                      <h2 className="mt-5 text-lg font-semibold">Your preview is getting ready</h2>
                      <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                        The Worker will generate your app and start a secure sandbox here.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col bg-[#1e1e24]">
              <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3 font-mono text-xs text-zinc-400">
                <FileCode2 className="h-4 w-4 text-sky-400" />
                {selectedFile}
                <span className="ml-auto text-[10px] text-zinc-500">
                  {fileContent !== savedContent ? "Unsaved changes" : `Version ${fileVersion}`}
                </span>
                <button
                  className="rounded bg-sky-500 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                  disabled={
                    isSaving ||
                    fileContent === savedContent ||
                    ["queued", "planning", "coding", "validating"].includes(runStatus)
                  }
                  onClick={saveFile}
                  type="button"
                >
                  {isSaving ? "Saving" : "Save"}
                </button>
                <button
                  className="rounded border border-white/20 px-2 py-1 text-[10px] text-zinc-300 disabled:opacity-40"
                  disabled={fileContent === savedContent}
                  onClick={() => {
                    setFileContent(savedContent);
                    setEditorError(null);
                  }}
                  type="button"
                >
                  Discard
                </button>
              </div>
              {editorError ? (
                <p className="bg-red-950 px-5 py-2 text-xs text-red-300">{editorError}</p>
              ) : null}
              <textarea
                aria-label={`Editing ${selectedFile}`}
                className="min-h-[500px] flex-1 resize-none bg-transparent p-6 font-mono text-sm leading-6 text-zinc-200 outline-none"
                onChange={(event) => setFileContent(event.target.value)}
                value={fileContent}
                spellCheck={false}
              />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
