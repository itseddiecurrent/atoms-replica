# Persistence, recovery, and download production acceptance

This gate continues the fixed initial generation and same-project incremental modification flow,
then proves that the final project survives browser and runtime boundaries. It targets only the
public production HTTPS Web service and uses the dedicated account described in
`docs/testing/dedicated-test-account.md`.

## Run the gate

Set `E2E_BASE_URL` to the public Web URL and ensure `.env.test-account` contains the ignored
dedicated credentials, then run from a trusted machine:

```sh
pnpm test:persistence
```

The local gate uses two Agent Runs and then waits for the actual `sandbox_expires_at` recorded by the
Worker. The normal production timeout is 900 seconds, so a complete acceptance takes materially
longer than the generation-only gates. `E2E_SANDBOX_EXPIRY_GRACE_MS` defaults to five seconds and
exists only to tolerate provider clock/cleanup skew. It must not be used to bypass the real expiry.

## Two-deployment Railway flow

A one-shot Railway process should not hold all evidence only in memory while idling through the
production Sandbox TTL. The Railway gate therefore uses two deployments of the same commit:

1. Set `E2E_PERSISTENCE_PHASE=prepare` and remove `E2E_PERSISTENCE_PROJECT_ID`, then deploy. The
   Runner performs both real Agent Runs and validates the durable graph. It prints a
   `Persistence Acceptance Checkpoint` and begins preserving that one temporary Project before
   launching Chromium, so a handled browser failure cannot discard two successful Runs. It then
   performs incremental browser checks, reload, and logout/login, and exits successfully without
   waiting. Only the explicit `Persistence prepare deployment passed` line marks prepare as complete.
2. Copy the exact Project ID from that record. After its printed `Original Sandbox expiry`, set
   `E2E_PERSISTENCE_PHASE=resume` and `E2E_PERSISTENCE_PROJECT_ID` to that ID, then redeploy the same
   commit. The Runner authenticates, owner-scopes and validates the complete checkpoint before any
   mutation. It never creates or spends another Agent Run in resume mode.
3. Resume re-verifies reload and a real logout/login, waits any remaining real TTL without a deploy
   settle delay, restores through the UI, edits, downloads, validates in a clean directory, prints
   the final record, and deletes the temporary Project.

The exact ID is mandatory: resume never selects a Project by name or “latest” timestamp, so it cannot
mutate or clean up an unrelated Project. If prepare fails before writing a valid checkpoint, its
normal `finally` cleanup remains active. If a handled failure occurs after the checkpoint is printed,
the exact checkpoint Project is retained for diagnosis or resume. Chromium startup is attempted
twice, and any terminal error is logged in bounded, credential-redacted form before cleanup. The
local `pnpm test:persistence` command defaults to the single-process `full` phase;
`E2E_PERSISTENCE_PHASE=full` can also be set explicitly.

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
image with `restartPolicyType: NEVER`. Each prepare or resume deployment therefore executes exactly
once. The runner receives only the public Web URL, Firebase Browser key, dedicated account
credentials, phase, and the non-secret checkpoint Project ID. OpenAI, E2B, database, Firebase Admin,
and Supabase Service Role credentials remain outside the runner.

The prepare checkpoint is deliberately retained for resume. If resume is abandoned, delete that
exact Project manually before starting another prepare deployment. Resume deletes the temporary
Project on success and its normal `finally` cleanup deletes it on a handled failure. Afterward, use
privileged read-only checks to correlate the production record with deployments, identify the exact
unreferenced acceptance Sandboxes and Snapshot objects, and remove only those confirmed temporary
resources.
