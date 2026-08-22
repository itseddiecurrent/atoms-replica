import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the initial idea prompt", async () => {
    const html = renderToStaticMarkup(await HomePage({}));

    expect(html).toContain("Tell AI about your app idea");
    expect(html).toContain("Build a dashboard that tracks my daily water intake");
    expect(html).toContain("Create project");
  });

  it("restores a prompt passed back from sign-in", async () => {
    const html = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({ prompt: "Build a habit tracker" }) })
    );

    expect(html).toContain(">Build a habit tracker</textarea>");
  });
});
