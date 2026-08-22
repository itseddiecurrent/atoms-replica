import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("generated app template", () => {
  it("renders a valid starting screen", () => {
    expect(renderToStaticMarkup(<App />)).toContain("Your app is ready to be shaped");
  });
});
