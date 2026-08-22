import { describe, expect, it } from "vitest";

import { checkUserRateLimit, getUserRateLimits } from "./rate-limits";

describe("user run rate limits", () => {
  const limits = { dailyRuns: 20, messagesPerMinute: 6, concurrentRuns: 1 };

  it("allows usage below every limit", () => {
    expect(
      checkUserRateLimit({ dailyRuns: 1, recentMessages: 2, activeRuns: 0 }, limits)
    ).toBeNull();
  });

  it("reports daily, minute, and concurrency limits with retry timing", () => {
    expect(
      checkUserRateLimit(
        { dailyRuns: 20, recentMessages: 0, activeRuns: 0 },
        limits,
        new Date("2026-08-22T23:59:30.000Z")
      )
    ).toMatchObject({ reason: "daily_runs", retryAfterSeconds: 30 });
    expect(
      checkUserRateLimit({ dailyRuns: 1, recentMessages: 6, activeRuns: 0 }, limits)
    ).toMatchObject({ reason: "messages_per_minute", retryAfterSeconds: 60 });
    expect(
      checkUserRateLimit({ dailyRuns: 1, recentMessages: 1, activeRuns: 1 }, limits)
    ).toMatchObject({ reason: "concurrent_runs", retryAfterSeconds: 5 });
  });

  it("loads positive environment overrides and falls back safely", () => {
    expect(
      getUserRateLimits({
        MAX_DAILY_RUNS_PER_USER: "7",
        MAX_MESSAGES_PER_MINUTE_PER_USER: "3",
        MAX_CONCURRENT_RUNS_PER_USER: "2"
      })
    ).toEqual({ dailyRuns: 7, messagesPerMinute: 3, concurrentRuns: 2 });
    expect(getUserRateLimits({ MAX_DAILY_RUNS_PER_USER: "0" }).dailyRuns).toBe(20);
  });
});
