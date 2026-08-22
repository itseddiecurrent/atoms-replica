import { getUserRateUsage, type Database } from "@atom-replica/db";
import {
  checkUserRateLimit,
  getUserRateLimits,
  type RateLimitDecision
} from "@atom-replica/shared";

export class UserRateLimitError extends Error {
  constructor(readonly decision: RateLimitDecision) {
    super(decision.message);
    this.name = "UserRateLimitError";
  }
}

export async function enforceUserRunRateLimit(db: Database, userId: string, now = new Date()) {
  const usage = await getUserRateUsage(db, userId, now);
  const decision = checkUserRateLimit(usage, getUserRateLimits(), now);
  if (decision) throw new UserRateLimitError(decision);
}
