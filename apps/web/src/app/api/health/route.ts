import { checkDatabaseHealth } from "@atom-replica/db";
import { parseServerEnv } from "@atom-replica/shared/env";
import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/server/database";

export const runtime = "nodejs";

export async function GET() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    parseServerEnv(process.env);
    await Promise.race([
      checkDatabaseHealth(getDatabase()),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Database health check timed out.")), 3_000);
      })
    ]);
    return NextResponse.json({
      status: "ok",
      service: "web",
      database: "ok",
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch {
    console.error("[health] Database health check failed.");
    return NextResponse.json(
      { status: "unavailable", service: "web", database: "unavailable" },
      { status: 503 }
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
