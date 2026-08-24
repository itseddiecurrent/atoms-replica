# Production baseline gate

Run this read-only gate after the same Git commit has deployed successfully to Railway Web and
Worker. It does not create users, projects, Runs, or Sandbox resources.

## Evidence to copy from Railway

Set the following only in the trusted terminal used for acceptance. These values are identifiers and
confirmations, not application secrets:

| Variable                            | Source                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `BASELINE_PUBLIC_URL`               | Railway Web public HTTPS domain                                                      |
| `BASELINE_WEB_DEPLOYMENT_ID`        | Successful Web deployment details                                                    |
| `BASELINE_WEB_COMMIT_SHA`           | Full Git commit shown by the Web deployment                                          |
| `BASELINE_WORKER_DEPLOYMENT_ID`     | Successful Worker deployment details                                                 |
| `BASELINE_WORKER_COMMIT_SHA`        | Full Git commit shown by the Worker deployment                                       |
| `BASELINE_WORKER_POLLING_CONFIRMED` | Set to `true` after Worker logs show polling without restart or configuration errors |
| `BASELINE_FIREBASE_AUTH_CONFIRMED`  | Set to `true` after registration, logout, and login pass on the public domain        |

`BASELINE_GITHUB_URL` and `BASELINE_COMMIT_SHA` are optional. When omitted, the gate reads the
repository origin and current `HEAD`. Run it only from a clean `main` checkout matching production.

Execute `pnpm test:baseline`. The gate rejects localhost and non-HTTPS targets, mismatched Web and
Worker commits, missing confirmations, unavailable pages, and an unhealthy database. On success it
prints a Markdown evidence table containing the verification time, repository, commit, public URL,
deployment IDs, health result, Worker status, and Firebase confirmation. Save that output with the
manual acceptance evidence; it contains no credentials.

After this gate passes, proceed with the dedicated-account and live generation steps in
`feedback_implementation.md`.
