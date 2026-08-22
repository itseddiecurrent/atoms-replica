export type UserRateUsage = {
  dailyRuns: number;
  recentMessages: number;
  activeRuns: number;
};

export type UserRateLimits = {
  dailyRuns: number;
  messagesPerMinute: number;
  concurrentRuns: number;
};

export type RateLimitReason = "daily_runs" | "messages_per_minute" | "concurrent_runs";

export type RateLimitDecision = {
  reason: RateLimitReason;
  message: string;
  retryAfterSeconds: number;
};

export function getUserRateLimits(
  env: Record<string, string | undefined> = process.env
): UserRateLimits {
  return {
    dailyRuns: positiveInteger(env.MAX_DAILY_RUNS_PER_USER, 20),
    messagesPerMinute: positiveInteger(env.MAX_MESSAGES_PER_MINUTE_PER_USER, 6),
    concurrentRuns: positiveInteger(env.MAX_CONCURRENT_RUNS_PER_USER, 1)
  };
}

export function checkUserRateLimit(
  usage: UserRateUsage,
  limits: UserRateLimits,
  now = new Date()
): RateLimitDecision | null {
  if (usage.dailyRuns >= limits.dailyRuns) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return {
      reason: "daily_runs",
      message: `Daily run limit reached (${limits.dailyRuns}). Try again tomorrow.`,
      retryAfterSeconds: Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1_000))
    };
  }
  if (usage.recentMessages >= limits.messagesPerMinute) {
    return {
      reason: "messages_per_minute",
      message: `Message limit reached (${limits.messagesPerMinute} per minute). Try again shortly.`,
      retryAfterSeconds: 60
    };
  }
  if (usage.activeRuns >= limits.concurrentRuns) {
    return {
      reason: "concurrent_runs",
      message: `Concurrent run limit reached (${limits.concurrentRuns}). Wait for or cancel the active run.`,
      retryAfterSeconds: 5
    };
  }
  return null;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
