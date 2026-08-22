import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import { ProjectList } from "./project-list";

describe("ProjectList", () => {
  it("renders the empty state with a create link", () => {
    const html = renderToStaticMarkup(<ProjectList projects={[]} />);

    expect(html).toContain("No projects yet");
    expect(html).toContain('href="/"');
  });

  it("renders project names, statuses, and workspace links", () => {
    const html = renderToStaticMarkup(
      <ProjectList
        projects={[
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            userId: "user-1",
            name: "Water dashboard",
            status: "running",
            sandboxId: null,
            sandboxExpiresAt: null,
            previewUrl: null,
            latestSnapshotId: null,
            createdAt: new Date("2026-08-22T00:00:00.000Z"),
            updatedAt: new Date("2026-08-22T00:00:00.000Z"),
            latestRunStatus: "completed"
          }
        ]}
      />
    );

    expect(html).toContain("Water dashboard");
    expect(html).toContain("Running");
    expect(html).toContain("/projects/550e8400-e29b-41d4-a716-446655440000");
  });
});
