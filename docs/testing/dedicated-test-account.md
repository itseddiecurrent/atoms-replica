# Dedicated production test account

## Account contract

- Email: `test@test.com`
- Authentication: Firebase Email/Password
- Password: generated as 192 random bits encoded into 48 lowercase hexadecimal characters
- Credential location: ignored local file `.env.test-account`, mode `0600`
- Credential delivery: read from the local protected file and share only through a password manager
  or one-time encrypted link

The password is intentionally not copied into this tracked document. Committing it would give every
repository reader access to the production test account and would fail the repository secret gate.

## Provision or verify

Run `pnpm test:account:provision` from a trusted machine whose ignored `.env` contains the production
Firebase browser API key. On the first run the command generates the password, writes the protected
credential file, and registers `test@test.com`. On later runs it loads the same local password and
verifies that Firebase login still succeeds.

If Firebase already contains `test@test.com` but its password differs from the protected local hex
credential, the command uses the Firebase Admin values already present in the ignored `.env` to
reset that one account, revoke its old refresh tokens, and immediately verify the new password. The
command never prints the password and never writes it to Railway.

## Acceptance quota

The account uses the normal production safety limits:

- 20 Runs per UTC day
- 6 user messages per minute
- 1 concurrent Run

The feedback acceptance flow requires five Runs, so a fresh account has four times the required
daily capacity while preserving the single-Run concurrency guard. Provisioning refuses to continue
if configured limits fall below five daily Runs, two messages per minute, or one concurrent Run.

## Manual handoff

1. Open `.env.test-account` locally to retrieve the email and hex password.
2. Use a private browser window to register/sign in on the production public URL.
3. Confirm the account sees no projects belonging to another account.
4. Run the production smoke test from the repository root; it automatically loads the ignored
   `.env.test-account` after `.env` when the credentials are not already exported.
5. After acceptance, rotate the password if the account will be retained; otherwise delete the
   Firebase user and its disposable projects.
