import { listProjectsForUser } from "@atom-replica/db";
import { redirect } from "next/navigation";

import { getDatabase } from "@/lib/server/database";

import { LogoutButton } from "./logout-button";
import { ProjectList } from "./project-list";
import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import Link from "next/link";

export default async function ProjectsPage() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login?next=/projects");
    throw error;
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-violet-600">Atom Replica</p>
            <h1 className="mt-1 text-3xl font-semibold">Your projects</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
              href="/"
            >
              Create new project
            </Link>
            <LogoutButton />
          </div>
        </header>
        <p className="mt-2 text-sm text-zinc-500">{user.email}</p>
        <ProjectList projects={await listProjectsForUser(getDatabase(), user.id)} />
      </div>
    </main>
  );
}
