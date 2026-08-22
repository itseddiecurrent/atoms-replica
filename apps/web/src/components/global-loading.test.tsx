import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GlobalLoading } from "./global-loading";

describe("GlobalLoading", () => {
  it("renders an accessible loading status", () => {
    const html = renderToStaticMarkup(<GlobalLoading label="Opening workspace…" overlay />);

    expect(html).toContain('role="status"');
    expect(html).toContain("Opening workspace…");
    expect(html).toContain("animate-spin");
  });
});
