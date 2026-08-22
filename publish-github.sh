#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_url="https://github.com/itseddiecurrent/atoms-replica.git"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$project_root"

command -v git >/dev/null 2>&1 || fail "Git is not installed."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed."

if [ ! -d .git ]; then
  git init -b main
else
  git branch -M main
fi

existing_origin="$(git remote get-url origin 2>/dev/null || true)"
if [ -z "$existing_origin" ]; then
  git remote add origin "$repository_url"
else
  case "$existing_origin" in
    "${repository_url}" | "${repository_url%.git}") ;;
    *) fail "origin already points to $existing_origin; expected $repository_url." ;;
  esac
fi

printf '[1/4] Scanning repository files for secrets...\n'
pnpm security:scan

printf '\n[2/4] Staging release files and checking the Git boundary...\n'
git add -A

tracked_sensitive="$(git ls-files | awk '
  /(^|\/)\.env($|\.)/ && $0 !~ /(^|\/)\.env\.example$/ { print }
  /(^|\/).*(service[-_]?account|firebase[-_]?admin).*\.json$/ { print }
')"
if [ -n "$tracked_sensitive" ]; then
  printf 'ERROR: Sensitive files are staged or tracked:\n%s\n' "$tracked_sensitive" >&2
  exit 1
fi

# Run again after staging so the scanner also enforces its tracked-file rules.
pnpm security:scan

printf '\n[3/4] Creating the release commit...\n'
if ! git diff --cached --quiet; then
  git_author_name="$(git config user.name || true)"
  git_author_email="$(git config user.email || true)"

  if [ -z "$git_author_name" ]; then
    [ -t 0 ] || fail "Git author name is missing. Run: git config --global user.name 'Your Name'"
    read -r -p "Git author name: " git_author_name
    [ -n "$git_author_name" ] || fail "Git author name cannot be empty."
    git config user.name "$git_author_name"
  fi

  if [ -z "$git_author_email" ]; then
    [ -t 0 ] || fail "Git author email is missing. Configure your GitHub email, then rerun."
    read -r -p "Git author email: " git_author_email
    [ -n "$git_author_email" ] || fail "Git author email cannot be empty."
    git config user.email "$git_author_email"
  fi

  git commit -m "Prepare Atom Replica for production deployment"
else
  printf 'No new files need to be committed.\n'
fi

printf '\n[4/4] Pushing main to GitHub...\n'
# VS Code exports an askpass socket into integrated terminals. After VS Code or
# its Git extension restarts, the stale socket can swallow Git's credential
# prompt and fail with ECONNREFUSED. Use the real terminal for this explicit
# publish action; the macOS credential helper can cache the resulting token.
unset GIT_ASKPASS
unset SSH_ASKPASS
unset SSH_ASKPASS_REQUIRE
unset VSCODE_GIT_ASKPASS_NODE
unset VSCODE_GIT_ASKPASS_MAIN
unset VSCODE_GIT_ASKPASS_EXTRA_ARGS
unset VSCODE_GIT_IPC_HANDLE
export GIT_TERMINAL_PROMPT=1
git push -u origin main

printf '\nGitHub publish completed: %s\n' "${repository_url%.git}"
printf 'Commit: %s\n' "$(git rev-parse HEAD)"
