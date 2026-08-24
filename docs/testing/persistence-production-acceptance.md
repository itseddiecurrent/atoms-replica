# Persistence, recovery, and download production acceptance

This gate continues the fixed initial generation and same-project incremental modification flow,
then proves that the final project survives browser and runtime boundaries. It targets only the
public production HTTPS Web service and uses the dedicated account described in
`docs/testing/dedicated-test-account.md`.

## Run the gate

Set `E2E_BASE_URL` to the public Web URL and ensure `.env.test-account` contains the ignored
dedicated credentials, then run:

```sh
pnpm test:persistence
```

The gate uses two Agent Runs. It then waits for the actual `sandbox_expires_at` recorded by the
Worker; the normal production timeout is 900 seconds, so a complete acceptance takes materially
longer than the generation-only gates. `E2E_SANDBOX_EXPIRY_GRACE_MS` defaults to five seconds and
exists only to tolerate provider clock/cleanup skew. It must not be used to bypass the real expiry.

## Automated evidence

The gate requires all of the following:

- reload restores the Project, both user and assistant messages, the durable plan, final Running
  state, file tree, non-empty `src/App.tsx`, file version, and Preview URL;
- the Project appears on the Dashboard before logout and after a real Firebase email/password
  re-login, and the authenticated Workspace restores the same state;
- after the original Sandbox expiry, the user re-enters the Workspace and clicks Restart; the
  Worker creates a different Sandbox from the latest Snapshot plus Project Files, publishes a new
  HTTPS Preview, and preserves the incremental title, filters, and original Todo behavior;
- a browser opens `src/styles.css` in the IDE, adds a harmless visible acceptance marker, clicks
  Save, and waits for a durable `sync_file` Runtime Job; Worker rebuilds and restarts the static
  Preview, where Chromium verifies the marker and Todo behavior;
- the downloaded ZIP exactly matches every final server file and excludes `.env`, `node_modules`,
  `dist`, caches, coverage, and Git data;
- the ZIP is extracted into a fresh temporary directory, where `npm install`, production build,
  tests, a new Vite process, and the full Chromium Todo interaction pass independently;
- owner-scoped persistence metadata proves both Runs are completed with plans, four conversation
  messages reference those Runs, both Snapshots reference those Runs, the latest Snapshot pointer is
  valid, every Project File has a positive version, and Runtime Jobs have terminal states.

The successful report prints IDs, versions, counts, HTTP statuses, and boolean results. It never
prints the password, session Cookie, generated source, file hashes, Snapshot storage keys, command
output, or ZIP contents.

## Railway runner and cleanup

`railway.acceptance.json` starts `scripts/persistence-smoke.mjs` in the Node 24/Chromium acceptance
image with `restartPolicyType: NEVER`. The runner receives only the public Web URL, Firebase Browser
key, and dedicated account credentials. OpenAI, E2B, database, Firebase Admin, and Supabase Service
Role credentials remain outside the runner.

The temporary Project is deleted in `finally` on success or failure. Afterward, use privileged
read-only checks to correlate the production record with deployments, identify the exact unreferenced
acceptance Sandboxes and Snapshot objects, and remove only those confirmed temporary resources.
