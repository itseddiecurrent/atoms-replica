import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function getAdminAuth() {
  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: getRequiredEnv("FIREBASE_ADMIN_PROJECT_ID"),
        clientEmail: getRequiredEnv("FIREBASE_ADMIN_CLIENT_EMAIL"),
        privateKey: getRequiredEnv("FIREBASE_ADMIN_PRIVATE_KEY").replace(/\\n/g, "\n")
      })
    });

  return getAuth(app);
}
