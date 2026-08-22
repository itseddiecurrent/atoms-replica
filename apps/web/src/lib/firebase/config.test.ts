import { describe, expect, it } from "vitest";

import { createFirebaseConfig } from "./config";

describe("createFirebaseConfig", () => {
  it("maps public environment variables to Firebase config", () => {
    expect(
      createFirebaseConfig({
        NEXT_PUBLIC_FIREBASE_API_KEY: "api-key",
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "app.firebaseapp.com",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "app",
        NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "app.firebasestorage.app",
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123",
        NEXT_PUBLIC_FIREBASE_APP_ID: "app-id"
      })
    ).toEqual({
      apiKey: "api-key",
      authDomain: "app.firebaseapp.com",
      projectId: "app",
      storageBucket: "app.firebasestorage.app",
      messagingSenderId: "123",
      appId: "app-id"
    });
  });
});
