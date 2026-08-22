import { Suspense } from "react";

import { AuthForm } from "./auth-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-6 py-12">
      <Suspense fallback={<p>Loading sign-in…</p>}>
        <AuthForm />
      </Suspense>
    </main>
  );
}
