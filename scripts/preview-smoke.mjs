process.env.E2E_PREVIEW_ONLY = "true";

await import("./live-smoke.mjs");
