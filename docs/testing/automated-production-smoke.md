# Automated production smoke and fault acceptance

This is the Step 9 production gate. It runs against the public HTTPS Web service with the dedicated
test account and creates two disposable projects plus one ephemeral second Firebase account.

```sh
pnpm test:production-smoke
```

For Railway, deploy the temporary `acceptance-runner` with `railway.acceptance.json`. Its restart
policy is `NEVER`, so a failure cannot automatically repeat model or Sandbox spend. Configure only
the non-privileged acceptance variables in `deploy/acceptance.env.example`; the runner does not
receive OpenAI, E2B, database, Firebase Admin, or Supabase service-role credentials.

The gate proves all of the following against production:

- a real Todo generation reaches `completed`, passes the existing first-generation evidence
  validator, serves an HTTP 200 HTTPS Preview, restarts through a durable Runtime Job, and downloads
  a non-empty ZIP;
- the SSE client deliberately disconnects after its first durable event, resumes with
  `Last-Event-ID`, and receives strictly increasing event IDs with no duplicate;
- a second Run is cancelled only after the Worker claims it; its durable Run and terminal event both
  record `RUN_CANCELLED`, no Snapshot is created, and file paths/versions remain unchanged after the
  terminal event;
- a newly created second Firebase account receives 404 for Project, Files, File Content, Download,
  Persistence, Messages, Events, Cancel, Preview Restart, Runtime Job, and Delete surfaces; the same
  signed-out requests receive 401 or an authentication redirect;
- neither acceptance Project contains a queued/processing Runtime Job at cleanup time;
- deleting each Project creates a durable Worker cleanup job, and the runner waits for that job to
  kill the exact E2B Sandbox and delete every exact Snapshot Storage key before accepting cleanup;
- both Project IDs disappear from the dedicated account Dashboard and the ephemeral second Firebase
  account is deleted.

The token, turn, tool-call, duration, and build fault paths are deterministic release-gate tests, not
prompts that depend on model behavior. Agent tests force each configured limit. Worker tests prove
token/turn/tool-call limits become `AI_LIMIT`, duration becomes `RUN_TIMEOUT`, and a non-zero build
retains its exit code and stderr and becomes `BUILD_FAILED`. The live record lists these five
contracts only when the same commit has passed the repository release gate.

The final Markdown record deliberately excludes passwords, cookies, keys, prompt bodies, generated
source, Sandbox IDs, and Snapshot keys. Associate the Runner log with the same commit and Web/Worker
deployment IDs recorded by the production baseline gate. Also review Web, Worker, and E2B logs for
secret/source leakage before Step 9 is signed off.

After the temporary Runner finishes and both cleanup jobs report `completed`, run the privileged,
read-only hygiene audit from the trusted maintainer machine:

```sh
pnpm test:production-resources
```

It compares all database Sandbox/Snapshot references (including in-flight cleanup jobs) with the E2B
account and private Storage bucket, and rejects stale Runs, stale Worker jobs, old unreferenced
Sandboxes, or unreferenced Snapshot objects. It prints counts only, never resource IDs or credentials.
