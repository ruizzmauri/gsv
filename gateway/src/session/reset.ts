export type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number; // For daily mode (0-23)
  idleMinutes?: number; // For idle mode
};

export function getDailyResetTime(now: number, atHour: number): number {
  const date = new Date(now);
  date.setHours(atHour, 0, 0, 0);
  if (date.getTime() > now) {
    date.setDate(date.getDate() - 1);
  }
  return date.getTime();
}

export function shouldAutoResetByPolicy(
  policy: ResetPolicy | undefined,
  updatedAt: number,
  now: number = Date.now(),
): boolean {
  if (!policy || policy.mode === "manual") return false;

  if (policy.mode === "daily") {
    const atHour = policy.atHour ?? 4;
    const resetTime = getDailyResetTime(now, atHour);
    return updatedAt < resetTime;
  }

  if (policy.mode === "idle") {
    const idleMs = (policy.idleMinutes ?? 60) * 60_000;
    return now - updatedAt > idleMs;
  }

  return false;
}
