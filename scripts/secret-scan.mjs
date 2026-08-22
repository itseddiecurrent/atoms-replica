import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

import { isSensitiveTrackedPath } from "./secret-scan-rules.mjs";

const root = process.cwd();
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results"
]);
const excludedFiles = new Set([".env"]);
const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".plan",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const patterns = [
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  [
    "private key",
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]{80,}?-----END (?:RSA |EC )?PRIVATE KEY-----/g
  ],
  ["JWT/service key", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g]
];

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile() && !excludedFiles.has(entry.name) && textExtensions.has(extname(path)))
      files.push(path);
  }
  return files;
}

const findings = [];
try {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  })
    .split("\0")
    .filter(Boolean);
  for (const path of tracked) {
    if (isSensitiveTrackedPath(path)) findings.push(`${path}: sensitive file is tracked by Git`);
  }
} catch {
  // Step 15 initializes Git. Content scanning still runs before that point.
}

for (const path of await filesIn(root)) {
  const content = await readFile(path, "utf8").catch(() => "");
  if (!content) continue;
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (match[0].includes("<private-key>") || match[0].includes("[\\s\\S]")) continue;
      findings.push(`${relative(root, path)}: ${label}`);
    }
  }
}

if (findings.length) {
  console.error("Potential secrets found:\n" + findings.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Secret scan passed: no credential-shaped values found in repository files.");
}
