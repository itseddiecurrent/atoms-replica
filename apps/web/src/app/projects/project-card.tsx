"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Project, Run } from "@atom-replica/db";

type ListedProject = Project & { latestRunStatus: Run["status"] | null };

function statusLabel(status: Project["status"] | Run["status"]) {
  return status === "running" ? "Running" : status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClass(status: Project["status"] | Run["status"]) {
  if (status === "running") return "bg-emerald-50 text-emerald-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-700";
}

export function ProjectCard({ project }: { project: ListedProject }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function removeProject() {
    if (!window.confirm(`Delete “${project.name}”? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Unable to delete this project.");
      setDeleting(false);
      return;
    }
    router.refresh();
  }

  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-violet-300 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <Link className="group min-w-0 flex-1" href={`/projects/${project.id}`}>
          <h2 className="truncate font-semibold group-hover:text-violet-700">{project.name}</h2>
          <p className="mt-2 font-mono text-[10px] text-zinc-400">{project.id}</p>
        </Link>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(project.status)}`}
        >
          {statusLabel(project.status)}
        </span>
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        <div className="text-xs text-zinc-400">
          <p>
            Updated{" "}
            {project.updatedAt.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric"
            })}
          </p>
          <p className="mt-1">
            Latest run: {project.latestRunStatus ? statusLabel(project.latestRunStatus) : "None"}
          </p>
        </div>
        <button
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          disabled={deleting}
          onClick={removeProject}
          type="button"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
    </article>
  );
}
