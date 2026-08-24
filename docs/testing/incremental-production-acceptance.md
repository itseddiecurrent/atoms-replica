# Incremental modification production acceptance

This gate proves that a second Agent request changes the existing production project instead of
creating an unrelated project or replacing its history. It must target the public HTTPS Web URL and
uses the dedicated acceptance account from `docs/testing/dedicated-test-account.md`.

## Run the gate

Set `E2E_BASE_URL` and `E2E_FIREBASE_API_KEY`, ensure the ignored `.env.test-account` contains the
dedicated `E2E_EMAIL` and `E2E_PASSWORD`, then run:

```sh
pnpm test:incremental
```

The first Run uses the fixed Todo prompt. The second Run is queued through the same Project API with
the fixed follow-up prompt:

```text
把页面标题改成 Focus Todo，并增加 All、Active、Completed 三个筛选按钮。
```

The gate deliberately creates a temporary Project and deletes it after success or failure. Set
`E2E_MAX_WAIT_MS` only when the production Agent limit is intentionally longer than the default 12
minutes. Railway also waits 120 seconds before creating the Project so the new Worker deployment is
stable.

## Automated evidence

The gate rejects the result unless all of these conditions hold:

- both Runs use one Project ID and have distinct Run IDs;
- the follow-up API returns a distinct Message ID, and both user prompts are restored in the same
  authenticated Workspace;
- the Coder emits a safe `read_file` tool event for an existing file before the follow-up completes;
- dependency installation and the production build both exit successfully during the second Run;
- both `run.completed` events identify distinct durable Snapshot IDs;
- changed file content receives a higher version, unchanged content keeps its prior version, and the
  focused UI request changes only `src/` paths;
- the updated HTTPS Preview returns HTTP 200 and shows `Focus Todo` plus exact `All`, `Active`, and
  `Completed` controls;
- a real Chromium session verifies empty-input rejection, add, complete, restore, delete, remaining
  count `2 → 1 → 2 → 1`, and the behavior of all three filters;
- browser security errors and Preview mutation requests remain zero.

The successful `Incremental Modification Production Acceptance Record` contains IDs, paths,
versions, booleans, HTTP status, and the check time. It never prints account credentials, Cookies,
prompt text, generated source, or file hashes.

## Railway runner

`railway.acceptance.json` uses the Node 24/Chromium `Dockerfile.acceptance` and starts
`scripts/incremental-smoke.mjs`. The runner has `restartPolicyType: NEVER`, so a failed generation is
not automatically repeated. Its variables should contain only the public Web URL, Firebase Browser
API key, and dedicated test-account credentials; it must not receive OpenAI, E2B, database, Firebase
Admin, or Supabase Service Role secrets.

After the record is produced, correlate its time and commit with the Web, Worker, and runner
deployment IDs. Review that time window for credential, full-prompt, or generated-source leakage,
then confirm that cleanup released the temporary Project and any unreferenced Sandbox.
