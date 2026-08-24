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
