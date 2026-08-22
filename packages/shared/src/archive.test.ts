import { describe, expect, it } from "vitest";

import {
  createProjectZip,
  readProjectZip,
  safeArchiveName,
  shouldIncludeProjectFile
} from "./archive";

function localFileNames(zip: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    names.push(decoder.decode(zip.slice(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

describe("project ZIP archives", () => {
  it("creates a valid ZIP containing sorted source files", () => {
    const zip = createProjectZip([
      { path: "src/App.tsx", content: "export default function App() {}" },
      { path: "package.json", content: "{}" }
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(localFileNames(zip)).toEqual(["package.json", "src/App.tsx"]);
    expect(readProjectZip(zip)).toEqual([
      { path: "package.json", content: "{}" },
      { path: "src/App.tsx", content: "export default function App() {}" }
    ]);
  });

  it("excludes dependencies, build output, repositories, caches, and secrets", () => {
    const files = [
      "node_modules/react/index.js",
      "dist/index.js",
      ".git/config",
      ".env",
      ".env.local",
      ".vite/cache.json",
      "coverage/index.html"
    ];
    expect(files.every((path) => !shouldIncludeProjectFile(path))).toBe(true);
    expect(
      localFileNames(createProjectZip(files.map((path) => ({ path, content: "secret" }))))
    ).toEqual([]);
  });

  it("rejects unsafe paths and creates a safe download name", () => {
    expect(shouldIncludeProjectFile("../secret")).toBe(false);
    expect(shouldIncludeProjectFile("/etc/passwd")).toBe(false);
    expect(shouldIncludeProjectFile("src\\App.tsx")).toBe(false);
    expect(safeArchiveName(" My Sports App! ")).toBe("my-sports-app.zip");
  });
});
