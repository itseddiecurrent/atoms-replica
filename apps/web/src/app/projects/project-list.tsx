import Link from "next/link";

import type { Project, Run } from "@atom-replica/db";

import { ProjectCard } from "./project-card";

type ListedProject = Project & { latestRunStatus: Run["status"] | null };

export function ProjectList({ projects }: { projects: ListedProject[] }) {
  if (projects.length === 0) {
    return (
      <section className="mt-10 rounded-3xl border border-dashed border-zinc-300 bg-white p-12 text-center">
        <h2 className="text-xl font-medium">No projects yet</h2>
        <p className="mt-2 text-zinc-500">Describe an app idea to start your first project.</p>
        <Link
          className="mt-6 inline-flex rounded-full bg-zinc-950 px-5 py-3 text-sm font-medium text-white hover:bg-violet-700"
          href="/"
        >
          Create a project
        </Link>
      </section>
    );
  }

  return (
    <section className="mt-10 grid gap-4 sm:grid-cols-2">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </section>
  );
}
