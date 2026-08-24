process.env.E2E_PERSISTENCE_ONLY = "true";

await import("./live-smoke.mjs");
