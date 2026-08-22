"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type HomePromptProps = { initialPrompt?: string | undefined };

export function HomePrompt({ initialPrompt = "" }: HomePromptProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("Tell us what you want to build.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmedPrompt })
      });

      if (response.status === 401) {
        const next = `/?prompt=${encodeURIComponent(trimmedPrompt)}`;
        router.push(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to create the project.");
      }

      const result = (await response.json()) as { projectId: string; runId: string };
      router.push(`/projects/${result.projectId}?run=${result.runId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the project.");
      setPending(false);
    }
  }

  return (
    <form className="mt-8 space-y-4" onSubmit={submit}>
      <label className="sr-only" htmlFor="app-prompt">
        Describe the app you want to build
      </label>
      <textarea
        className="min-h-32 w-full resize-y rounded-2xl border border-zinc-200 bg-zinc-50 p-5 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-100"
        id="app-prompt"
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="For example: Build a dashboard that tracks my daily water intake"
        value={prompt}
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        className="rounded-full bg-zinc-950 px-5 py-3 font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={pending}
        type="submit"
      >
        {pending ? "Creating project…" : "Create project"}
      </button>
    </form>
  );
}
