import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

export const dedicatedTestEmail = "test@test.com";
export const credentialFile = ".env.test-account";
const requiredAcceptanceRuns = 5;
const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function acceptanceQuota(env) {
  const quota = {
    dailyRuns: positiveInteger(env.MAX_DAILY_RUNS_PER_USER, 20),
    messagesPerMinute: positiveInteger(env.MAX_MESSAGES_PER_MINUTE_PER_USER, 6),
    concurrentRuns: positiveInteger(env.MAX_CONCURRENT_RUNS_PER_USER, 1)
  };
  if (quota.dailyRuns < requiredAcceptanceRuns)
    throw new Error(`MAX_DAILY_RUNS_PER_USER must be at least ${requiredAcceptanceRuns}.`);
  if (quota.messagesPerMinute < 2)
    throw new Error("MAX_MESSAGES_PER_MINUTE_PER_USER must be at least 2.");
  if (quota.concurrentRuns < 1) throw new Error("MAX_CONCURRENT_RUNS_PER_USER must be at least 1.");
  return quota;
}

export function generateHexPassword(randomBytesImpl = randomBytes) {
  return randomBytesImpl(24).toString("hex");
}

function firebaseError(body) {
  return typeof body?.error?.message === "string" ? body.error.message : "UNKNOWN_FIREBASE_ERROR";
}

async function firebasePasswordRequest(fetchImpl, apiKey, operation, email, password) {
  const response = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/accounts:${operation}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  const body = await response.json().catch(() => undefined);
  return { ok: response.ok, body, error: firebaseError(body) };
}

function credentialContents(password) {
  return `# Generated locally for the dedicated production acceptance account.
# This file is ignored by Git. Never paste it into tracked documentation or Railway.
E2E_EMAIL=${dedicatedTestEmail}
E2E_PASSWORD=${password}
`;
}

export function createFirebaseAdminAuth(env) {
  const projectId = env.FIREBASE_ADMIN_PROJECT_ID?.trim();
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim();
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey)
    throw new Error(
      "Firebase Admin configuration is required to reset an existing dedicated test account."
    );
  const { cert, getApps, initializeApp } = requireFromWeb("firebase-admin/app");
  const { getAuth } = requireFromWeb("firebase-admin/auth");
  const app =
    getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return getAuth(app);
}

export async function provisionTestAccount({
  env = process.env,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
  adminAuthFactory = createFirebaseAdminAuth,
  outputPath = credentialFile
} = {}) {
  const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim();
  if (!apiKey) throw new Error("NEXT_PUBLIC_FIREBASE_API_KEY is required.");
  const quota = acceptanceQuota(env);
  const existingPassword = env.E2E_PASSWORD?.trim();
  const password = existingPassword || generateHexPassword(randomBytesImpl);
  if (!/^[a-f0-9]{48}$/.test(password))
    throw new Error("E2E_PASSWORD must be the generated 48-character lowercase hex value.");

  await writeFileImpl(outputPath, credentialContents(password), { mode: 0o600 });
  await chmodImpl(outputPath, 0o600);

  if (existingPassword) {
    const login = await firebasePasswordRequest(
      fetchImpl,
      apiKey,
      "signInWithPassword",
      dedicatedTestEmail,
      password
    );
    if (login.ok)
      return {
        email: dedicatedTestEmail,
        credentialPath: outputPath,
        firebaseUid: login.body?.localId,
        action: "verified",
        quota
      };
  }

  const signup = await firebasePasswordRequest(
    fetchImpl,
    apiKey,
    "signUp",
    dedicatedTestEmail,
    password
  );
  if (!signup.ok) {
    if (signup.error === "EMAIL_EXISTS") {
      const adminAuth = adminAuthFactory(env);
      const existingUser = await adminAuth.getUserByEmail(dedicatedTestEmail);
      await adminAuth.updateUser(existingUser.uid, { password, disabled: false });
      await adminAuth.revokeRefreshTokens(existingUser.uid);
      const verification = await firebasePasswordRequest(
        fetchImpl,
        apiKey,
        "signInWithPassword",
        dedicatedTestEmail,
        password
      );
      if (!verification.ok)
        throw new Error(
          `Firebase accepted the password reset but login verification failed: ${verification.error}.`
        );
      return {
        email: dedicatedTestEmail,
        credentialPath: outputPath,
        firebaseUid: existingUser.uid,
        action: "reset-and-verified",
        quota
      };
    }
    throw new Error(`Firebase account provisioning failed: ${signup.error}.`);
  }

  return {
    email: dedicatedTestEmail,
    credentialPath: outputPath,
    firebaseUid: signup.body?.localId,
    action: "created",
    quota
  };
}

async function loadLocalEnvironment() {
  for (const path of [".env", credentialFile]) {
    try {
      loadEnvFile(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function main() {
  await loadLocalEnvironment();
  const result = await provisionTestAccount();
  console.info(`Dedicated Firebase test account ${result.action}: ${result.email}`);
  console.info(`Credentials stored locally in ${result.credentialPath} with mode 0600.`);
  console.info(
    `Acceptance quota confirmed: ${result.quota.dailyRuns} runs/day, ${result.quota.messagesPerMinute} messages/minute, ${result.quota.concurrentRuns} concurrent run.`
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
