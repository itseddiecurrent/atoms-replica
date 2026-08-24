# First production generation acceptance

Step 5 validates one real initial generation through the public production URL. Deploy the same
commit to Web and Worker before testing. The dedicated Firebase account, OpenAI readiness, and E2B
readiness from Steps 2–4 must already pass.

## Automated production Gate

Set `E2E_BASE_URL` to the public HTTPS Web URL in local `.env`. The command automatically loads the
dedicated credentials from `.env.test-account`, creates a temporary project, and deletes it after the
check:

```sh
pnpm test:generation
```

It uses the fixed prompt:

```text
创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。
```

The Gate requires the durable event sequence `queued → planning → plan → coding → tool/file activity
→ validating → Preview → completed`. It also requires all six detailed progress stages, successful
`npm install --no-audit --no-fund` and `npm run build` exit codes, an HTTPS Preview, persisted files,
and non-empty `src/App.tsx`. A generic completion such as “Done” is rejected; the summary must state
that files were saved, independent validation passed, and Preview is live.

The output is a source-free Markdown record containing timestamp, Project ID, Run ID, terminal
state, event count, stages, file count, validation commands, Preview URL, and the clear completion
summary. It never includes credentials or generated source.

## Run the Gate entirely on Railway

For final production evidence, create a third temporary Railway service named `acceptance-runner` in
the same Project and Environment as Web and Worker. Point it to the same GitHub repository and exact
commit, then set its Config File path to `/railway.acceptance.json`.

Set only these service-scoped variables on `acceptance-runner`:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `E2E_BASE_URL`         | The public Railway Web HTTPS URL         |
| `E2E_EMAIL`            | Dedicated test account email             |
| `E2E_PASSWORD`         | Dedicated test account password          |
| `E2E_FIREBASE_API_KEY` | The Firebase browser API key used by Web |
| `E2E_MAX_WAIT_MS`      | `720000`                                 |

Do not copy Web, Worker, database, OpenAI, E2B, Firebase Admin, or Supabase secrets into this
service. The Runner only acts like a remote browser against the public Web URL. Public Networking and
a healthcheck are not required.

The config uses `restartPolicyType: NEVER`, so the acceptance test runs exactly once per deployment
and exits instead of retrying a failed test and consuming more Run/OpenAI/E2B quota. A successful
deployment ends as `Completed`; its Deploy Logs contain the `First Production Generation Record`.
Use Railway Redeploy when an intentional rerun is required.

After saving the record, delete `acceptance-runner` or remove `E2E_PASSWORD`, then rotate the
dedicated account password. Never add these Runner variables to Web or Worker.

## Manual UI check

Use a private browser window and the dedicated test account. Create the same fixed Todo project and
confirm:

1. The header shows the current phase and percentage rather than only an indefinite spinner.
2. The Activity progress card advances monotonically through planning, workspace, coding,
   validation, Preview, and saving.
3. Activity names the concrete tool and target, for example `Writing file · src/App.tsx`, without
   showing entire file contents.
4. File events identify their real paths and the Files panel contains no placeholder source.
5. Validation shows both commands, their exit code, and a bounded output summary.
6. Preview readiness and project persistence are separate visible milestones.
7. The completion message reports persisted file count, successful independent validation, live
   Preview, and the Agent's implementation summary.
8. Opening `src/App.tsx` loads non-empty source and the Run has one terminal `completed` state.

If the Run fails, Activity must retain the last known percentage and display the stable error code,
diagnostic, and recovery actions. Queued, Coding, or Validating without an eventual terminal event is
not accepted.

For `SANDBOX_FAILED` during Preview startup, use the complete failure message to distinguish the
two boundaries. A failed Sandbox-local probe or an exited Vite process identifies an app/process
startup problem; a successful local HTTP probe combined with a public 502 identifies the E2B Preview
edge or hostname path. The diagnostic is bounded and must not contain generated source or secrets.
The production Preview serves the independently built `dist` output with a zero-dependency Node HTTP
process, so the E2B Template does not need to satisfy Vite's development-server Node minor version.
