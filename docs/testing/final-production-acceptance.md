# Final production acceptance

Status: **accepted**. Steps 1–9 of the feedback acceptance plan passed against the public
production system, and the evidence below closes Step 10. No acceptance blocker remains.

## Signed production baseline

| Field                     | Evidence                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified at               | `2026-08-24T14:55:04.483Z`                                                                                                                     |
| Public URL                | <https://web-production-8c2330.up.railway.app>                                                                                                 |
| GitHub repository         | <https://github.com/itseddiecurrent/atoms-replica>                                                                                             |
| Production commit         | [`c2368c08732283117c322d57a000749b69934854`](https://github.com/itseddiecurrent/atoms-replica/commit/c2368c08732283117c322d57a000749b69934854) |
| Release gate              | [GitHub Actions run 32739541925](https://github.com/itseddiecurrent/atoms-replica/actions/runs/32739541925), passed                            |
| Web deployment            | `b75be1a8-ce6b-4de6-b89e-26c14a90f3bf`                                                                                                         |
| Worker deployment         | `86b6f5b3-e9e4-46d5-bd81-78632bbef921`                                                                                                         |
| Web health                | Homepage, login, and `/api/health` HTTP 200; database `ok`                                                                                     |
| Worker and authentication | Worker polling and Firebase registration/login confirmed                                                                                       |

The final Step 9 production smoke ran against application commit
[`6af8d03b1ac6d9ec3de18e7a6f50467d48f92754`](https://github.com/itseddiecurrent/atoms-replica/commit/6af8d03b1ac6d9ec3de18e7a6f50467d48f92754),
with Web deployment `66966136-e0be-491e-86af-390a5b9ed6c1` and Worker deployment
`f84aa597-21ea-483b-9f60-a6c7244727af`. The commits after that accepted run add production
resource-audit recovery, acceptance-runner recovery, and this evidence record; the final release
gate passed before the baseline above was signed.

## Test account handoff

- Account: `test@test.com`, Firebase Email/Password authentication.
- The 192-bit temporary password is held only in the ignored `.env.test-account` file with mode
  `0600`. It is not present in Git, Railway variables, screenshots, or this report.
- Deliver the password through a password manager or one-time encrypted link. The recipient can use
  the public URL immediately and should rotate the password after review if the account is retained.
- The account has 20 Runs per UTC day, 6 user messages per minute, and 1 concurrent Run. It can see
  only its own projects.

See [Dedicated production test account](./dedicated-test-account.md) for provisioning, verification,
handoff, rotation, and deletion instructions.

## Model and runtime readiness

| Boundary       | Accepted configuration and evidence                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI         | Project-scoped key in Worker only; model `gpt-5.6-sol`; Responses API and strict tool call verified; Project ownership, budget/balance, and rate-limit capacity confirmed before production Runs |
| Agent limits   | 12,000 output tokens per response; 200,000 cumulative tokens per Run; 20 turns; 60 tool calls; 2 repair attempts; 600-second Run limit                                                           |
| E2B            | API key in Worker only; default Template; Node/npm verified; Credits and concurrency confirmed; one Worker slot                                                                                  |
| Sandbox limits | 900-second TTL; port 5173; 120-second command limit; HTTPS Preview restricted to `https://*.e2b.app` rather than `*`                                                                             |

The later production records additionally prove that both providers completed real Runs: OpenAI
planned and generated the Todo applications, while E2B installed dependencies, built them, served
HTTPS Previews, restarted and restored Sandboxes, and released test resources. Provider keys,
responses, generated source, Sandbox IDs, and Snapshot keys are intentionally omitted.

## Acceptance evidence

The original Step 5 record was produced by Runner commit
`6afe731e4a6bf5023e002804fc34d94f169e4a07` against Web/Worker commit
`813423b24adfd8e40ab720a9982cd98ea51241d6`. It saved 13 files and passed independent install,
build, generated tests, HTTPS Preview, durable persistence, and automatic Project cleanup. The
newer records below repeat that first-generation path as part of broader browser and fault gates.

| Area                                | Production result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First generation                    | The fixed Chinese Todo prompt completed with 13 persisted files, independent dependency installation, production build and model-generated tests, a non-empty `src/App.tsx`, and an HTTP 200 HTTPS Preview. The later full smoke reconfirmed this with Project `3b5cdde5-1c99-4608-948d-c5d8f5871a38` and Run `6051bc84-7b85-4a84-af72-5882b3dc2cda`.                                                                                                                                                                                                                                                                                        |
| Preview                             | Record time `2026-08-24T09:41:01.270Z`; Project `ea4b6ebb-609b-46b7-9235-e4cda446fb3c`, Run `a2235462-651a-437f-a5f8-0173a77ce7d1`, Runtime Job `588f6264-89ab-4138-b088-1b19c4403117`. Add, complete, restore, delete, empty-input, count `2 → 1 → 2 → 1`, iframe reload, and UI Restart all passed; security errors and remote mutation requests were zero.                                                                                                                                                                                                                                                                                |
| Incremental modification            | Record time `2026-08-24T10:21:25.663Z`; Project `eeaa4237-10f9-4acc-8162-ffad6bced797`; Runs `d4ba6736-2fdf-415f-9616-0c1111d07e26` and `89c54b76-4cbf-45f8-a1b9-598af7d3cf33`; Snapshots `2346d211-288f-41b9-bc98-4237324a11c6` and `365c2f66-ee58-41e9-aa59-a00d283f406c`. Focus Todo and all three filters worked; original Todo behavior remained intact; four relevant files changed and nine unchanged files retained their versions.                                                                                                                                                                                                  |
| Persistence, recovery, and download | Project `dbcb8091-b3cd-45c9-a5b8-e8005d8ae04e`; Runs `20054157-0d86-467e-bf60-b3f32cc03396` and `6a7bd60f-212a-44ef-9c4a-d084ab1b1a1c`; Snapshots `13452aae-0c9e-4074-ab55-9f4ae276d7b9` and `2596ab6e-fd16-4ce5-bda1-955d3101dfe0`. Refresh, logout/login, Dashboard, conversation, plan, files, versions, terminal state, and Preview recovered. After the original Sandbox expired at `2026-08-24T13:33:29.948Z`, a different Sandbox restored the final version. IDE sync updated Preview. The ZIP exactly matched server files, excluded sensitive/build data, and passed clean install, build, tests, server, and browser interaction. |
| Automated smoke and faults          | Record time `2026-08-24T14:32:02.825Z`; successful Project/Run `3b5cdde5-1c99-4608-948d-c5d8f5871a38` / `6051bc84-7b85-4a84-af72-5882b3dc2cda`; cancelled Project/Run `f36ed46c-a0c2-4d45-9be3-1ec1162e23b9` / `6b52b9e3-288b-42dd-a565-a651ec7a2774`. SSE resumed with 71 unique increasing event IDs. Cancellation produced `RUN_CANCELLED` without later writes or a Snapshot. Eleven owner boundaries returned 404 to a second account and 401/auth redirect while signed out. Token/turn/tool limits mapped to `AI_LIMIT`, time limits to `RUN_TIMEOUT`, and build failure to `BUILD_FAILED` with exit code and stderr retained.        |
| Cleanup                             | Both final smoke cleanup jobs completed, both Project IDs disappeared, and the temporary second Firebase account was deleted. The final audit at `2026-08-24T14:32:33.915Z` found 0 stale Runs, 0 stale Runtime Jobs, 0 stale cleanup jobs, 0 Snapshot objects, and 0 active E2B Sandboxes.                                                                                                                                                                                                                                                                                                                                                  |

The disposable evidence Projects and their private Snapshots were removed after verification. Their
IDs remain here only to correlate the sanitized Railway acceptance records; no credential, prompt
log beyond the two published fixed acceptance prompts, source file, private Storage key, or Sandbox
identifier is recorded.

## Resolved findings and re-acceptance

| Finding                                                                                            | Owner and repair scope                                                                                                                  | Re-acceptance                                                                                                    | Status                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| E2B Preview returned 502 and Vite failed on the default Template's Node minor                      | Worker/Sandbox adapter: serve validated `dist` with Node's HTTP server and prune dependency/build trees before persistence              | Repeat fixed first-generation gate; require build exit 0, HTTPS Preview 200, durable files/Snapshot, and cleanup | Resolved in Step 5           |
| Preview Restart failed during reconnect, TTL renewal, restore, or launcher overwrite               | Worker/Sandbox adapter: stage-specific errors, reconnect readiness, rebuild-on-restore, stop/remove/recreate launcher                   | Browser clicks Restart; require completed `restart_preview` Runtime Job and healthy HTTPS URL                    | Resolved in Step 6           |
| Persistence runner exceeded its deployment window; Dashboard and Todo count checks raced rendering | Acceptance gate: split prepare/resume, preserve exact checkpoint, wait for Dashboard ID, normalize DOM whitespace                       | Expire the real Sandbox, resume in a clean deployment, then complete IDE, ZIP, clean-build, and browser checks   | Resolved in Step 8           |
| Project deletion left private Snapshots and E2B Sandboxes                                          | Web/Worker cleanup: durable owner-scoped cleanup jobs plus exact-resource audit and maintenance cleanup                                 | Delete both smoke Projects, wait for cleanup jobs, then require all stale/orphan counts to be zero               | Resolved in Step 9           |
| Extra SSE disconnects or an error during smoke cleanup could obscure the final result              | Acceptance runner and resource audit: reconnect loop, early terminal diagnostics, bounded cleanup retry, serial read-only audit queries | Repeat smoke evidence validation and final global resource audit                                                 | Resolved in Step 9 hardening |

There are no failed, pending, ownerless, or blocked acceptance items.

## Reviewer reproduction without a repository checkout

1. Receive the `test@test.com` password through the private delivery channel and open the
   [production URL](https://web-production-8c2330.up.railway.app) in a private browser window.
2. Sign in, create a project, and send
   `创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。`
3. Require a completed Run, explicit planning/coding/validation activity, a populated file tree,
   non-empty `src/App.tsx`, and a working HTTPS Preview. Exercise add, complete, restore, delete,
   empty-input handling, and remaining count.
4. In the same project send
   `把页面标题改成 Focus Todo，并增加 All、Active、Completed 三个筛选按钮。` Confirm the new
   title and filters and repeat the original interactions.
5. Reload the Workspace, sign out and back in, reopen the project from the Dashboard, and use
   **Restart Preview**. Conversation, files, terminal state, Preview, and behavior must recover.
6. Make a harmless visible edit in the IDE and save it; confirm Preview updates. Download the ZIP
   and verify it contains project source but no `.env`, `node_modules`, `dist`, cache, coverage, or
   Git data.
7. Delete the disposable project and rotate or revoke the shared test credential after review.

For repeat deployments, start with [Production baseline](./production-baseline.md), then follow the
specialized checklists in this directory. Do not reuse the IDs above as proof for a new commit; every
new release needs its own commit-matched deployment IDs, timestamps, sanitized records, and cleanup
audit.
