import { describe, expect, it } from "vitest";
import {
  getDailyResetTime,
  shouldAutoResetByPolicy,
  type ResetPolicy,
} from "./session/reset";

function localTimeToday(hour: number, minute: number = 0): number {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

describe("session reset policy", () => {
  it("does not auto-reset when policy is missing or manual", () => {
    const now = Date.now();
    const updatedAt = now - 24 * 60 * 60 * 1000;

    expect(shouldAutoResetByPolicy(undefined, updatedAt, now)).toBe(false);
    expect(
      shouldAutoResetByPolicy({ mode: "manual" }, updatedAt, now),
    ).toBe(false);
  });

  it("resets on idle timeout only after the threshold", () => {
    const now = Date.now();
    const policy: ResetPolicy = { mode: "idle", idleMinutes: 15 };
    const thresholdMs = 15 * 60 * 1000;

    expect(
      shouldAutoResetByPolicy(policy, now - thresholdMs, now),
    ).toBe(false);
    expect(
      shouldAutoResetByPolicy(policy, now - thresholdMs - 1, now),
    ).toBe(true);
  });

  it("resets daily when last update happened before today's reset boundary", () => {
    const now = localTimeToday(10, 0);
    const policy: ResetPolicy = { mode: "daily", atHour: 4 };
    const resetTime = getDailyResetTime(now, 4);

    expect(shouldAutoResetByPolicy(policy, resetTime - 1, now)).toBe(true);
    expect(shouldAutoResetByPolicy(policy, resetTime + 1, now)).toBe(false);
  });

  it("daily reset boundary uses previous day when current time is before reset hour", () => {
    const now = localTimeToday(2, 0);
    const resetTime = getDailyResetTime(now, 4);

    const expected = new Date(now);
    expected.setHours(4, 0, 0, 0);
    expected.setDate(expected.getDate() - 1);

    expect(resetTime).toBe(expected.getTime());
  });
});
