import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

import { Workspace } from "./workspace";

describe("Workspace", () => {
  it("renders the activity, files, and preview surfaces", () => {
    const html = renderToStaticMarkup(
      <Workspace projectId="project-1" projectName="Water dashboard" runId="run-12345678" />
    );

    expect(html).toContain("Activity");
    expect(html).toContain("Files");
    expect(html).toContain("Your preview is getting ready");
    expect(html).toContain("Preview");
    expect(html).toContain("Editor");
    expect(html).toContain("Ask for a change");
    expect(html).toContain("Dashboard");
    expect(html).toContain("Generation progress");
    expect(html).toContain("100%");
    expect(html).toContain('href="/api/projects/project-1/download"');
  });

  it("does not render fake generated files before the Worker writes them", () => {
    const html = renderToStaticMarkup(
      <Workspace projectId="project-1" projectName="Water dashboard" />
    );

    expect(html).toContain("No generated files yet");
    expect(html).not.toContain("App.tsx");
    expect(html).toContain('aria-label="Send message"');
  });

  it("renders persisted conversation messages", () => {
    const html = renderToStaticMarkup(
      <Workspace
        projectId="project-1"
        projectName="Water dashboard"
        messages={[
          {
            id: "message-1",
            role: "user",
            content: "Build a water dashboard",
            createdAt: new Date("2026-08-22T00:00:00.000Z")
          }
        ]}
      />
    );

    expect(html).toContain("Build a water dashboard");
  });

  it("does not expose Restart as interactive before client hydration", () => {
    const html = renderToStaticMarkup(
      <Workspace projectId="project-1" projectName="Water dashboard" />
    );

    expect(html).toContain('data-runtime-ready="false"');
    expect(html).toMatch(/data-runtime-ready="false"[^>]*disabled=""/);
  });

  it("renders a persisted preview with strict iframe permissions", () => {
    const html = renderToStaticMarkup(
      <Workspace
        projectId="project-1"
        projectName="Water dashboard"
        initialPreviewUrl="https://preview.example.com"
      />
    );

    expect(html).toContain('src="https://preview.example.com"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups"');
    expect(html).not.toContain("allow-same-origin");
  });

  it("renders cancellation while a run is active", () => {
    const html = renderToStaticMarkup(
      <Workspace
        projectId="project-1"
        projectName="Water dashboard"
        runId="run-1"
        initialRunStatus="coding"
      />
    );
    expect(html).toContain("Cancel");
    expect(html).toContain("Coding · 30%");
  });

  it("renders failure-specific recovery actions", () => {
    const html = renderToStaticMarkup(
      <Workspace
        projectId="project-1"
        projectName="Water dashboard"
        initialRunStatus="failed"
        initialRunErrorCode="SANDBOX_FAILED"
        initialRunErrorMessage="Sandbox unavailable."
      />
    );
    expect(html).toContain("Retry run");
    expect(html).toContain("Restart preview");
    expect(html).toContain("Continue chatting");
    expect(html).toContain("Download code");
  });
});
