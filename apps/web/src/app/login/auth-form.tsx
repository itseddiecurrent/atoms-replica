"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  type UserCredential
} from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

import { GlobalLoading } from "@/components/global-loading";
import { firebaseAuth } from "@/lib/firebase/client";
import { getSafeNextPath } from "@/lib/routing";

async function establishServerSession(credential: UserCredential) {
  const idToken = await credential.user.getIdToken();
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!response.ok) throw new Error("Unable to create a secure session.");
}

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "create">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nextPath = getSafeNextPath(searchParams.get("next"));

  async function finish(credential: UserCredential) {
    await establishServerSession(credential);
    router.replace(nextPath);
    router.refresh();
  }

  async function handleGoogle() {
    setPending(true);
    setError(null);
    try {
      await finish(await signInWithPopup(firebaseAuth, new GoogleAuthProvider()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Google sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  async function handleEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const credential =
        mode === "create"
          ? await createUserWithEmailAndPassword(firebaseAuth, email, password)
          : await signInWithEmailAndPassword(firebaseAuth, email, password);
      await finish(credential);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Email sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {pending ? <GlobalLoading label="Signing you in…" overlay /> : null}
      <div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-violet-600">Atom Replica</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {mode === "create" ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm text-zinc-500">Sign in to start building your app with AI.</p>

        <button
          className="mt-7 w-full rounded-xl border border-zinc-300 px-4 py-3 font-medium hover:bg-zinc-50 disabled:opacity-50"
          disabled={pending}
          onClick={handleGoogle}
          type="button"
        >
          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200" /> or{" "}
          <span className="h-px flex-1 bg-zinc-200" />
        </div>

        <form className="space-y-4" onSubmit={handleEmail}>
          <label className="block text-sm font-medium">
            Email
            <input
              autoComplete="email"
              className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 font-normal outline-none focus:border-violet-500"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              autoComplete={mode === "create" ? "new-password" : "current-password"}
              className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 font-normal outline-none focus:border-violet-500"
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            className="w-full rounded-xl bg-zinc-950 px-4 py-3 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            disabled={pending}
            type="submit"
          >
            {pending ? "Please wait…" : mode === "create" ? "Create account" : "Sign in"}
          </button>
        </form>

        <button
          className="mt-5 w-full text-sm text-zinc-600 underline-offset-4 hover:underline"
          disabled={pending}
          onClick={() => setMode(mode === "create" ? "sign-in" : "create")}
          type="button"
        >
          {mode === "create" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </div>
    </>
  );
}
