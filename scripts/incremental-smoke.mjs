process.env.E2E_INCREMENTAL_ONLY = "true";

await import("./live-smoke.mjs");
