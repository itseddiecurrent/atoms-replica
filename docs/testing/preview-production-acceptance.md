# Preview production acceptance

Step 6 is a browser-level production Gate. It must target the public HTTPS Web URL and use the
dedicated Firebase account from Step 2. A localhost Preview or a source-code assertion is not a
substitute for this check.

## What the Gate proves

`pnpm test:preview` creates the fixed Todo project from Step 5, waits for the real OpenAI/E2B Run,
then starts headless Chromium and verifies all of the following:

1. The generated HTTPS Preview returns HTTP 200 and is automatically present in the authenticated
   workspace iframe.
2. Reloading the workspace restores the same server-persisted Preview URL and loads it again.
3. Empty submission is rejected; two Todos can be added; one can be completed and restored; the
   other can be deleted.
4. The unfinished counter follows `2 → 1 → 2 → 1` and the Todo operations issue no remote mutation
   requests, confirming browser-local state.
5. Chromium observes no CSP, mixed-content, origin, or frame-blocking failure.
6. The Gate clicks the workspace's **Restart** button. It then proves the UI queued a durable runtime
   job, the Worker completed it as `restart_preview`, and the returned HTTPS Preview is healthy.

The Restart control stays disabled until React hydration has attached its handler. The Gate waits
for that explicit client-ready state before clicking, then reports queue, Worker terminal, and UI
result failures separately instead of collapsing them into one timeout. Runtime operations allow
six minutes because an expired Sandbox may legitimately require a dependency install and public
Preview health check before it can report success. Reconnecting to a live Sandbox renews its E2B
TTL and persists the renewed expiry before Restart runs.

The generated Project is deleted in `finally`, including when an assertion fails. The evidence
record contains IDs, statuses, and behavioral results only; it never prints the session cookie,
credentials, Prompt text, browser request headers, or generated source.

## Trusted-machine command

Set `E2E_BASE_URL` to the public production URL and load the ignored `.env.test-account` credentials:

```sh
pnpm test:preview
```

The browser launcher discovers Chrome on macOS and Chromium/Chrome on Linux. Set
`E2E_BROWSER_EXECUTABLE_PATH` only when the browser is installed elsewhere. The current managed
development sandbox cannot launch macOS GUI application binaries, so run this command in a normal
terminal or use the Railway runner below.

## Railway acceptance runner

The temporary `acceptance-runner` uses `/railway.acceptance.json`. Its dedicated
`Dockerfile.acceptance` installs Chromium in a Node 24 image and starts `scripts/preview-smoke.mjs`,
which selects Preview-only mode without relying on shell environment-assignment syntax. It runs the
same browser Gate once with `restartPolicyType: NEVER`. Configure only:

| Variable               | Purpose                             |
| ---------------------- | ----------------------------------- |
| `E2E_BASE_URL`         | Public Railway Web HTTPS URL        |
| `E2E_EMAIL`            | Dedicated test account email        |
| `E2E_PASSWORD`         | Dedicated test account password     |
| `E2E_FIREBASE_API_KEY` | Web's browser-safe Firebase API key |
| `E2E_MAX_WAIT_MS`      | `720000`                            |
| `E2E_DEPLOY_SETTLE_MS` | `120000`                            |

Do not give this service database, Supabase service-role, Firebase Admin, OpenAI, or E2B keys. A
successful Deploy Log ends with `Preview production acceptance passed` and contains a
`Preview Production Acceptance Record`. The first lines must identify release
`step6-browser-preview-interaction-v6` and the Railway source commit; reject logs from an older
release even if they were produced by manually restarting an earlier deployment.

## Log boundary check

After the automated Gate succeeds, inspect that deployment's Web and Worker logs plus the E2B
Sandbox logs for the recorded Project/Run time window. Provider logs may contain provider,
operation, duration, status, and request ID. They must not contain the dedicated password, session
cookie, fixed Prompt, generated Todo text, or source-file contents. Record the Web deployment ID,
Worker deployment ID, acceptance-runner deployment ID, and log-inspection time beside the browser
record before marking Step 6 complete.
