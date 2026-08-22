# Manual production smoke test

Run this after Web and Worker are both live and the automated `pnpm test:smoke` gate passes. Use a
new or dedicated email/password account so limits and old data cannot hide defects.

For the pre-Step-15 local candidate, use Node 24, add the three `E2E_*` values to the ignored local
`.env`, then run the one-command launcher. It validates the complete Web/Worker environment, selects
the Homebrew Node 24 binary when available, installs the locked dependencies, applies pending
database migrations, builds shared packages, and starts both processes:

```sh
./run-local.sh
```

For local migrations the launcher derives the Supabase IPv4 Session Pooler endpoint (port 5432)
from `DATABASE_URL`. This avoids IPv6 timeouts on the Direct DB hostname. Railway's Web pre-deploy
migration uses the same Session Pooler endpoint through the compatibility variable
`DATABASE_URL_DIRECT`.

Use `./run-local.sh --check` for a read-only prerequisite check. The existing lower-level commands
remain available when Web and Worker need to be debugged separately.

In a second terminal run `pnpm test:smoke`. The same command works after deployment by exporting
`E2E_BASE_URL=https://<railway-web-domain>`; the smoke runner does not otherwise depend on localhost.

## Before testing

- `GET https://<web-domain>/api/health` returns HTTP 200 with `database: "ok"`.
- Railway Web logs show a successful one-time migration and no missing-variable errors.
- Railway Worker logs show polling enabled, with no Firebase variables and no public domain.
- Web variables contain no OpenAI or E2B key; Worker variables contain no Firebase key/private key.
- Firebase lists the exact Railway Web hostname as an authorized domain.

## Browser flow

1. Open the public HTTPS homepage in a private browser window and create/sign in to an account.
2. Submit exactly: `创建一个带添加、完成和删除功能的 Todo App`.
3. Confirm the workspace shows planning, coding, validation, file changes, and a terminal success;
   refresh once during generation to exercise SSE replay/reconnection.
4. In Preview, add two Todos, mark one complete, delete the other, and confirm the remaining count.
5. Send: `Add a visible count of remaining Todo items.` Confirm a second run completes and Preview
   updates without losing the existing project.
6. Open `src/App.tsx` in Editor, make a harmless visible text change, save, wait for the
   `Synchronized src/App.tsx to Preview.` activity, and confirm Preview updates.
7. Refresh the workspace and confirm messages, files, versions, Preview URL, and final status recover.
8. Use Restart Preview and confirm it completes through the Worker. Repeat after the E2B sandbox has
   expired if testing recovery from Snapshot.
9. Download the ZIP in a clean temporary directory; run `pnpm install && pnpm dev`, then exercise the
   Todo interactions locally.
10. Cancel one disposable run and confirm it reaches `RUN_CANCELLED` without permanent loading.
11. Delete the disposable project from the dashboard. E2B sandboxes are additionally bounded by
    `E2B_SANDBOX_TIMEOUT_SECONDS`; confirm they disappear from E2B after that timeout.

## Security and failure checks

- While signed out, project, file, download, run-event, cancel, and runtime-job URLs return 401 or
  redirect to login.
- A second account cannot access the first account's IDs; protected APIs return 404 rather than
  revealing ownership.
- Requests containing `../`, absolute paths, backslashes, `.env`, build output, or dependency paths
  are rejected and never appear in downloads.
- Disconnect/reconnect the browser network during a run. Events resume without duplicates and the
  run reaches one terminal state.
- Temporarily use an invalid database URL only in a disposable deployment: `/api/health` returns
  non-2xx and Railway does not promote the unhealthy release.
- Review Web/Worker logs and Sentry: no Prompt, generated source, session cookie, database password,
  Firebase private key, OpenAI key, E2B key, or Supabase service key is present.
