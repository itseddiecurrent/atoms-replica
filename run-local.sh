#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="$project_root/.env"
check_only=false
skip_install=false
skip_migration=false

usage() {
  printf '%s\n' \
    "Usage: ./run-local.sh [options]" \
    "" \
    "Starts the Web app and Worker together for a complete local test." \
    "" \
    "Options:" \
    "  --check           Validate local prerequisites without changing or starting anything" \
    "  --skip-install    Do not run the frozen-lockfile dependency install" \
    "  --skip-migration  Do not apply pending database migrations" \
    "  -h, --help        Show this help"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for argument in "$@"; do
  case "$argument" in
    --check)
      check_only=true
      ;;
    --skip-install)
      skip_install=true
      ;;
    --skip-migration)
      skip_migration=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown option: $argument"
      ;;
  esac
done

cd "$project_root"

# Prefer the repository's supported Node major. Homebrew can install multiple
# Node versions, and its unversioned node binary may otherwise win in PATH.
current_node_major=""
if command -v node >/dev/null 2>&1; then
  current_node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi

if [ "$current_node_major" != "24" ] && command -v brew >/dev/null 2>&1; then
  brew_node_prefix="$(brew --prefix node@24 2>/dev/null || true)"
  if [ -n "$brew_node_prefix" ] && [ -x "$brew_node_prefix/bin/node" ]; then
    PATH="$brew_node_prefix/bin:$PATH"
    export PATH
    current_node_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi
fi

[ "$current_node_major" = "24" ] || fail \
  "Node.js 24 is required. Install it with 'brew install node@24' or select Node 24 with your version manager."

package_runner=()
if command -v pnpm >/dev/null 2>&1; then
  package_runner=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  package_runner=(corepack pnpm)
else
  fail "pnpm is unavailable. Install pnpm 10 or install a Node.js 24 distribution that includes Corepack."
fi

pnpm_version="$("${package_runner[@]}" --version)"
case "$pnpm_version" in
  10.*) ;;
  *) fail "pnpm 10 is required; found pnpm $pnpm_version." ;;
esac

[ -f "$env_file" ] || fail ".env is missing. Copy .env.example to .env and fill in every required value."

read_env_value() {
  local key="$1"
  awk -v target="$key" '
    index($0, target "=") == 1 {
      value = substr($0, length(target) + 2)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$env_file"
}

is_missing_value() {
  local value="$1"
  case "$value" in
    "" | '""' | "''" | \<*\>) return 0 ;;
    *) return 1 ;;
  esac
}

required_variables=(
  NEXT_PUBLIC_APP_URL
  SESSION_COOKIE_NAME
  APP_ENCRYPTION_KEY
  DATABASE_URL
  DATABASE_URL_DIRECT
  NEXT_PUBLIC_FIREBASE_API_KEY
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
  NEXT_PUBLIC_FIREBASE_PROJECT_ID
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
  NEXT_PUBLIC_FIREBASE_APP_ID
  FIREBASE_ADMIN_PROJECT_ID
  FIREBASE_ADMIN_CLIENT_EMAIL
  FIREBASE_ADMIN_PRIVATE_KEY
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_STORAGE_BUCKET
  OPENAI_API_KEY
  OPENAI_MODEL
  OPENAI_MAX_OUTPUT_TOKENS
  E2B_API_KEY
  E2B_SANDBOX_TIMEOUT_SECONDS
  E2B_PREVIEW_PORT
  WORKER_CONCURRENCY
  WORKER_DISABLED
  WORKER_POLL_INTERVAL_MS
  RUN_HEARTBEAT_INTERVAL_MS
  RUN_STALE_AFTER_SECONDS
  MAX_AGENT_TURNS
  MAX_AGENT_TOOL_CALLS
  MAX_AGENT_REPAIR_ATTEMPTS
  MAX_RUN_DURATION_SECONDS
  MAX_COMMAND_DURATION_SECONDS
)

missing_variables=()
for variable_name in "${required_variables[@]}"; do
  variable_value="$(read_env_value "$variable_name")"
  if is_missing_value "$variable_value"; then
    missing_variables+=("$variable_name")
  fi
done

if [ "${#missing_variables[@]}" -gt 0 ]; then
  printf 'ERROR: .env is missing required values:\n' >&2
  printf '  - %s\n' "${missing_variables[@]}" >&2
  exit 1
fi

worker_disabled="$(read_env_value WORKER_DISABLED)"
worker_disabled="${worker_disabled%\"}"
worker_disabled="${worker_disabled#\"}"
[ "$worker_disabled" = "false" ] || fail \
  "WORKER_DISABLED must be false; otherwise queued runs cannot generate code."

app_url="$(read_env_value NEXT_PUBLIC_APP_URL)"
app_url="${app_url%\"}"
app_url="${app_url#\"}"
app_host="$(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(url.hostname);
' "$app_url" 2>/dev/null)" || fail "NEXT_PUBLIC_APP_URL must be a valid URL."
app_port="$(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(url.port || (url.protocol === "https:" ? "443" : "80"));
' "$app_url" 2>/dev/null)" || fail "NEXT_PUBLIC_APP_URL must be a valid URL."

case "$app_host" in
  localhost | 127.0.0.1) ;;
  *) fail "NEXT_PUBLIC_APP_URL must use localhost for local testing; found $app_host." ;;
esac

migration_database_url=""
if [ "$skip_migration" = false ]; then
  runtime_database_url="$(read_env_value DATABASE_URL)"
  runtime_database_url="${runtime_database_url%\"}"
  runtime_database_url="${runtime_database_url#\"}"
  migration_database_url="$(node -e '
    const url = new URL(process.argv[1]);
    if (!url.hostname.endsWith(".pooler.supabase.com")) {
      throw new Error("DATABASE_URL is not a Supabase Pooler URL.");
    }
    url.port = "5432";
    url.searchParams.set("sslmode", "require");
    process.stdout.write(url.toString());
  ' "$runtime_database_url" 2>/dev/null)" || fail \
    "Could not derive the local migration URL from DATABASE_URL. Use a Supabase Pooler connection string."
fi

printf 'Local runtime checks passed (Node %s, pnpm %s).\n' "$(node --version)" "$pnpm_version"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$app_port" -sTCP:LISTEN >/dev/null 2>&1; then
  if [ "$check_only" = true ]; then
    printf 'Port %s is currently in use; stop the existing server before a full start.\n' "$app_port"
  else
    fail "Port $app_port is already in use. Stop the existing Web server, then run this script again."
  fi
fi

if [ "$check_only" = true ]; then
  printf 'Check complete. Web and Worker configuration is ready.\n'
  exit 0
fi

if [ "$skip_install" = false ]; then
  printf '\n[1/4] Installing exact dependencies from pnpm-lock.yaml...\n'
  "${package_runner[@]}" install --frozen-lockfile
else
  printf '\n[1/4] Dependency install skipped.\n'
fi

if [ "$skip_migration" = false ]; then
  printf '\n[2/4] Applying pending database migrations through the IPv4 Session Pooler...\n'
  DATABASE_URL_DIRECT="$migration_database_url" \
    "${package_runner[@]}" --filter @atom-replica/db db:migrate
else
  printf '\n[2/4] Database migration skipped.\n'
fi

printf '\n[3/4] Building shared packages...\n'
"${package_runner[@]}" run dev:prepare

printf '\n[4/4] Starting Web and Worker...\n'
printf 'Open %s after Next.js reports that it is ready. Press Ctrl-C once to stop everything.\n\n' "$app_url"

PORT="$app_port" exec "${package_runner[@]}" --parallel --filter './apps/*' dev
