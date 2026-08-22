"use client";

import { signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { firebaseAuth } from "@/lib/firebase/client";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    await fetch("/api/auth/logout", { method: "DELETE" });
    await signOut(firebaseAuth);
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50"
      disabled={pending}
      onClick={logout}
      type="button"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
