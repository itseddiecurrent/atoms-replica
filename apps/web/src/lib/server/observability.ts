import { captureException } from "@atom-replica/shared";

export function reportServerError(error: unknown, context: Record<string, unknown>) {
  const dsn = process.env.SENTRY_DSN;
  return captureException(error, { ...(dsn ? { dsn } : {}), context });
}
