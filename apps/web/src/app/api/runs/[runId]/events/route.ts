import { getRunForUser, listRunEventsAfter } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";

export const runtime = "nodejs";

const runIdSchema = z.uuid();
const terminalEvents = new Set(["run.completed", "run.failed", "run.cancelled"]);

function eventChunk(
  runId: string,
  event: { id: number; type: string; payloadJson: unknown; createdAt: Date }
) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    eventId: event.id,
    runId,
    timestamp: event.createdAt.toISOString(),
    type: event.type,
    payload: event.payloadJson
  })}\n\n`;
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Authentication required."), {
        status: 401
      });
    }
    throw error;
  }

  const { runId } = await params;
  if (!runIdSchema.safeParse(runId).success) {
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid run id."), {
      status: 400
    });
  }

  const database = getDatabase();
  const ownedRun = await getRunForUser(database, { runId, userId: user.id });
  if (!ownedRun)
    return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Run not found."), { status: 404 });

  const lastEventId = Number(request.headers.get("last-event-id") ?? "0");
  const afterEventId = Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;
  const encoder = new TextEncoder();
  let cancelPolling: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = afterEventId;
      let closed = false;
      let lastHeartbeatAt = Date.now();
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      cancelPolling = () => {
        closed = true;
      };

      const poll = async () => {
        if (closed) return;
        const events = await listRunEventsAfter(database, runId, cursor);
        for (const event of events) {
          cursor = event.id;
          controller.enqueue(encoder.encode(eventChunk(runId, event)));
          if (terminalEvents.has(event.type)) {
            close();
            return;
          }
        }
        if (["completed", "failed", "cancelled"].includes(ownedRun.run.status)) {
          close();
          return;
        }
        if (Date.now() - lastHeartbeatAt >= 15_000) {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
          lastHeartbeatAt = Date.now();
        }
        if (!closed) setTimeout(poll, 500);
      };

      request.signal.addEventListener("abort", close, { once: true });
      await poll();
    },
    cancel() {
      cancelPolling();
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    }
  });
}
