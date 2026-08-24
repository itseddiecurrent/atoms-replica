# E2B Runtime production readiness

This gate validates the exact remote runtime contract used by the Railway Worker. It creates one
short-lived E2B Sandbox, writes a minimal Vite probe, confirms Node and npm, installs dependencies,
runs a production build, starts Vite on the configured port, requests the HTTPS Preview, and always
releases the Sandbox. No local runtime or globally installed pnpm is used inside the probe.

Before running it, open the E2B dashboard and confirm that the account has enough Credits and
Sandbox concurrency for the complete five-Run acceptance flow. The confirmation variables below are
runner-only acknowledgements; do not add them to Railway, GitHub, or `.env`.

```sh
E2B_CREDITS_CONFIRMED=true \
E2B_CONCURRENCY_CONFIRMED=true \
pnpm test:e2b:readiness
```

The command loads the same E2B values as the Worker from local `.env`. Use the same values configured
on Railway. It emits a secret-free Markdown record containing the Sandbox ID, creation time,
Template, Node/npm versions, build and Preview results, non-sensitive timeout/port/CSP settings, and
release time. It never prints the API key or probe source.

Production safeguards enforced by the gate:

| Setting                        | Required value                                        |
| ------------------------------ | ----------------------------------------------------- |
| `E2B_SANDBOX_TIMEOUT_SECONDS`  | At least 600; current baseline 900                    |
| `MAX_COMMAND_DURATION_SECONDS` | At least 120                                          |
| `E2B_PREVIEW_PORT`             | Non-privileged port 1024–65535; current baseline 5173 |
| `WORKER_CONCURRENCY`           | At least 1 and covered by E2B account concurrency     |
| `E2B_PREVIEW_CSP_ORIGIN`       | One HTTPS origin or wildcard subdomain; never `*`     |

An empty `E2B_TEMPLATE_ID` intentionally selects E2B's default Template. The live probe verifies the
actual selected Template rather than assuming it contains Node/npm. A configured Template ID is
passed through unchanged and recorded in the evidence.

If any operation fails after creation, cleanup still runs in `finally`. Missing Node/npm, install and
build failures retain the command label, exit code, and bounded diagnostic output. A Preview outside
the configured CSP origin is rejected before it can be accepted as healthy.
