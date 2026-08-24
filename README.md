# Atom Replica

Atom Replica is a production-oriented AI app-builder demo. A signed-in user describes a small web
application, follows planning and code-generation events in real time, interacts with an isolated
preview, requests follow-up changes, edits generated files, and downloads the result.

Repository: <https://github.com/itseddiecurrent/atoms-replica>

Production: <https://web-production-8c2330.up.railway.app>

The complete sanitized production sign-off is in
[`docs/testing/final-production-acceptance.md`](./docs/testing/final-production-acceptance.md).

## Architecture

- `apps/web` — Next.js UI, Firebase authentication, protected API routes, and SSE event delivery.
- `apps/worker` — PostgreSQL polling worker for OpenAI generation, validation, snapshots, and
  durable E2B runtime jobs.
- `packages/db` — Drizzle schema, migrations, repositories, and Supabase Storage integration.
- `packages/agent` — bounded planner/coder orchestration and tool policy.
- `packages/sandbox` — E2B lifecycle, file, command, and preview adapter.
- `packages/shared` — environment contracts, events, observability, and archive utilities.
- `templates/react-vite` — fixed generated-application runtime template.

Web never receives OpenAI, E2B, Supabase service-role, or Snapshot Storage credentials. Worker never
receives Firebase Browser/Admin credentials and has no public domain. Generated code executes only
inside E2B, with explicit time, turn, tool-call, and command limits.

## Local development

Requirements:

- Node.js 24
- pnpm 10
- Firebase Authentication
- Supabase PostgreSQL and a private `project-snapshots` bucket
- OpenAI API access
- E2B API access

Copy `.env.example` to the ignored `.env`, replace all required placeholders, then run:

```sh
./run-local.sh
```

The launcher validates the complete environment, selects Homebrew Node 24 when available, installs
the locked dependencies, applies migrations through the Supabase IPv4 Session Pooler, builds shared
packages, and starts Web plus Worker. Open <http://localhost:3000>. Use `Ctrl-C` to stop both.

For a read-only prerequisite check:

```sh
./run-local.sh --check
```

## Environment and deployment

- Local variable template: [`.env.example`](./.env.example)
- Railway Web variables: [`deploy/web.env.example`](./deploy/web.env.example)
- Railway Worker variables: [`deploy/worker.env.example`](./deploy/worker.env.example)
- Temporary Railway acceptance variables:
  [`deploy/acceptance.env.example`](./deploy/acceptance.env.example)
- Railway deployment contract: [`docs/deployment/railway.md`](./docs/deployment/railway.md)
- Production smoke checklist:
  [`docs/testing/manual-production-smoke.md`](./docs/testing/manual-production-smoke.md)
- Preview production acceptance:
  [`docs/testing/preview-production-acceptance.md`](./docs/testing/preview-production-acceptance.md)
- Incremental modification production acceptance:
  [`docs/testing/incremental-production-acceptance.md`](./docs/testing/incremental-production-acceptance.md)
- Persistence, recovery, and download production acceptance:
  [`docs/testing/persistence-production-acceptance.md`](./docs/testing/persistence-production-acceptance.md)
- Automated production smoke, fault, authorization, and cleanup acceptance:
  [`docs/testing/automated-production-smoke.md`](./docs/testing/automated-production-smoke.md)
- Final production acceptance and reviewer handoff:
  [`docs/testing/final-production-acceptance.md`](./docs/testing/final-production-acceptance.md)

Railway deploys this monorepo as two services from `main`:

| Service             | Config file                | Public network | Lifecycle       |
| ------------------- | -------------------------- | -------------- | --------------- |
| `web`               | `/railway.web.json`        | HTTPS enabled  | Persistent      |
| `worker`            | `/railway.worker.json`     | Disabled       | Persistent      |
| `acceptance-runner` | `/railway.acceptance.json` | Disabled       | Temporary, once |

Only Railway Variables contain production secrets. A real `.env` or service-account JSON must never
be committed or uploaded to either service.

## Release gate

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm security:scan
pnpm build:web
pnpm build:worker
```

GitHub Actions runs the same gate on every push to `main` and every pull request. Railway services
can enable **Wait for CI** so a failed commit is not deployed.

The initial secure GitHub publish can be performed from the repository root with:

```sh
./publish-github.sh
```

The publisher refuses to track `.env` or service-account files and never force-pushes over an
existing remote history.
