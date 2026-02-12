import { describe, expect, it } from "vitest";
import { computeNextRunAtMs, validateCronSchedule } from "./schedule";

describe("cron schedule", () => {
  it("keeps one-shot at schedules", () => {
    const next = computeNextRunAtMs({ kind: "at", atMs: 1_700_000_000_000 }, 0);
    expect(next).toBe(1_700_000_000_000);
  });

  it("computes next interval for every schedules", () => {
    const now = 10_000;
    const next = computeNextRunAtMs(
      { kind: "every", everyMs: 3_000, anchorMs: 1_000 },
      now,
    );
    expect(next).toBe(13_000);
  });

  it("computes next cron minute with step", () => {
    const now = Date.UTC(2026, 1, 11, 10, 7, 30); // 2026-02-11 10:07:30 UTC
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "*/15 * * * *", tz: "UTC" },
      now,
    );
    expect(next).toBe(Date.UTC(2026, 1, 11, 10, 15, 0));
  });

  it("supports day-of-week matching", () => {
    const now = Date.UTC(2026, 1, 11, 10, 7, 30); // Wednesday
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 11 * * 3", tz: "UTC" },
      now,
    );
    expect(next).toBe(Date.UTC(2026, 1, 11, 11, 0, 0));
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      validateCronSchedule({ kind: "cron", expr: "* * *", tz: "UTC" }),
    ).toThrow(/5 fields/);
  });
});
