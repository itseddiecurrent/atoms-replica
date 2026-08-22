# Railway production contract

This repository deploys as two Railway services from the same GitHub repository. Do not upload a
local `.env` file and do not copy variables between services as one block.

## Web service

- Config-as-code path: `/railway.web.json`
- Build: `pnpm --filter @atom-replica/web... build`
- Pre-deploy migration: `pnpm --filter @atom-replica/db db:migrate:prod`
- Start: `pnpm --filter web start`
- Health check: `/api/health`
- Public networking: enabled
- Variables: copy names from `deploy/web.env.example` and replace every placeholder in Railway

The dependency-aware build selector (`web...`) builds `packages/db` and `packages/shared` before
Next.js. `next start -H 0.0.0.0` reads Railway's `PORT` automatically. The readiness endpoint returns
HTTP 503 when PostgreSQL is unavailable, so a Web release is not promoted against a broken database.

`DATABASE_URL` must be the Supabase transaction pooler URL used by application traffic. Web does
not receive the Supabase service-role key or Storage configuration.
`DATABASE_URL_DIRECT` is used only by the Web pre-deploy migration. Never run the migration from the
Worker service. Despite the compatibility name, Railway should set this variable to the Supabase
Shared Pooler **session mode** URL on port 5432. Session mode supports migrations over IPv4 and
avoids depending on the IPv6-only Direct DB hostname or Railway's optional outbound IPv6 setting.
`DATABASE_URL` uses the same Pooler credentials and hostname on transaction-mode port 6543.

## Worker service

- Config-as-code path: `/railway.worker.json`
- Build: `pnpm --filter @atom-replica/worker... build`
- Start: `pnpm --filter worker start`
- Pre-deploy command: none
- Public networking: disabled
- Variables: copy names from `deploy/worker.env.example` and replace every placeholder in Railway

The Worker is the only service that receives `OPENAI_API_KEY` and `E2B_API_KEY`. It processes Agent
runs and durable runtime jobs for manual file synchronization and Preview restart. The Web service
must not contain either secret. The Worker does not receive Firebase browser or Firebase Admin
configuration.

`OPENAI_MAX_OUTPUT_TOKENS` limits one Responses API call, including visible output and reasoning
tokens. `MAX_AGENT_TOTAL_TOKENS` is the separate cumulative budget for the complete multi-turn Run;
the production baseline is `200000`. Keep both variables on the Worker only.

## Required external settings

1. Keep the Supabase `project-snapshots` bucket private.
2. Add the Railway Web hostname to Firebase Authentication authorized domains.
3. Set `NEXT_PUBLIC_APP_URL` to the final Railway HTTPS URL, then redeploy Web.
4. Set `E2B_PREVIEW_CSP_ORIGIN` to the narrow Preview origin supported by the active E2B template.
   The default is `https://*.e2b.app`; never use `*`.
5. Use Node.js 24. The root `engines`, `.node-version`, and `.nvmrc` all pin the supported major.
6. Configure an OpenAI Project budget and E2B limits outside this application.

## Release gate

From a trusted machine with the dedicated test account variables loaded, run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm security:scan
pnpm build:web
pnpm build:worker
pnpm test:smoke
```

`pnpm test:smoke` targets `E2E_BASE_URL`; it does not start or depend on a local Web/Worker process.
It signs in through Firebase, creates the fixed Todo App, deliberately reconnects SSE with
`Last-Event-ID`, verifies Preview, performs a follow-up run, synchronizes a manual edit through the
Worker, restarts Preview, validates the ZIP, and deletes its database project.
