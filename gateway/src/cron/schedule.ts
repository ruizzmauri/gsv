import type { CronSchedule } from "./types";

type ParsedField = {
  wildcard: boolean;
  values: Set<number>;
  min: number;
  max: number;
};

type ParsedCron = {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
  tz?: string;
};

const WEEKDAY_TO_INT: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

export function validateCronSchedule(schedule: CronSchedule): void {
  if (schedule.kind === "at") {
    if (!Number.isFinite(schedule.atMs)) {
      throw new Error("schedule.atMs must be a finite number");
    }
    return;
  }

  if (schedule.kind === "every") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error("schedule.everyMs must be a positive number");
    }
    if (
      schedule.anchorMs !== undefined &&
      (!Number.isFinite(schedule.anchorMs) || schedule.anchorMs < 0)
    ) {
      throw new Error("schedule.anchorMs must be a finite non-negative number");
    }
    return;
  }

  parseCronExpr(schedule.expr, schedule.tz);
}

export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  if (schedule.kind === "at") {
    return Number.isFinite(schedule.atMs) ? schedule.atMs : undefined;
  }

  if (schedule.kind === "every") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
      return undefined;
    }

    const anchorMs =
      schedule.anchorMs !== undefined && Number.isFinite(schedule.anchorMs)
        ? schedule.anchorMs
        : nowMs;

    if (anchorMs > nowMs) {
      return anchorMs;
    }

    const elapsed = nowMs - anchorMs;
    const runsElapsed = Math.floor(elapsed / schedule.everyMs) + 1;
    return anchorMs + runsElapsed * schedule.everyMs;
  }

  const parsed = parseCronExpr(schedule.expr, schedule.tz);
  return findNextCronTimeMs(parsed, nowMs);
}

function parseCronExpr(expr: string, tz?: string): ParsedCron {
  const trimmed = expr.trim();
  if (!trimmed) {
    throw new Error("cron expression is empty");
  }

  const fields = trimmed.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error("cron expression must contain exactly 5 fields");
  }

  if (tz?.trim()) {
    // Throws for invalid timezones.
    getFormatter(tz.trim());
  }

  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dayOfWeek: parseField(fields[4], 0, 7, "day-of-week", {
      normalizeSevenToZero: true,
    }),
    tz: tz?.trim() || undefined,
  };
}

function parseField(
  rawField: string,
  min: number,
  max: number,
  label: string,
  options?: { normalizeSevenToZero?: boolean },
): ParsedField {
  const raw = rawField.trim();
  if (!raw) {
    throw new Error(`cron ${label} field is empty`);
  }

  if (raw === "*") {
    return { wildcard: true, values: new Set<number>(), min, max };
  }

  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) {
      throw new Error(`cron ${label} field has an empty list element`);
    }

    const [base, stepText] = piece.split("/");
    const step = stepText === undefined ? 1 : parseStep(stepText, label);

    const range = parseRange(base, min, max, label);
    for (let value = range.start; value <= range.end; value += step) {
      values.add(normalizeValue(value, options));
    }
  }

  if (values.size === 0) {
    throw new Error(`cron ${label} field resolved to no values`);
  }

  return { wildcard: false, values, min, max };
}

function parseStep(stepText: string, label: string): number {
  const parsed = Number.parseInt(stepText, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`cron ${label} field has invalid step: ${stepText}`);
  }
  return parsed;
}

function parseRange(
  raw: string,
  min: number,
  max: number,
  label: string,
): { start: number; end: number } {
  const base = raw.trim();
  if (!base) {
    throw new Error(`cron ${label} field has an empty range`);
  }

  if (base === "*") {
    return { start: min, end: max };
  }

  if (base.includes("-")) {
    const [left, right] = base.split("-", 2);
    const start = parseValue(left, min, max, label);
    const end = parseValue(right, min, max, label);
    if (start > end) {
      throw new Error(`cron ${label} field range start exceeds end: ${base}`);
    }
    return { start, end };
  }

  const value = parseValue(base, min, max, label);
  return { start: value, end: value };
}

function parseValue(raw: string, min: number, max: number, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`cron ${label} field contains non-numeric value: ${raw}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(
      `cron ${label} value out of range (${min}-${max}): ${raw}`,
    );
  }
  return parsed;
}

function normalizeValue(
  value: number,
  options?: { normalizeSevenToZero?: boolean },
): number {
  if (options?.normalizeSevenToZero && value === 7) {
    return 0;
  }
  return value;
}

function matchesField(field: ParsedField, value: number): boolean {
  return field.wildcard || field.values.has(value);
}

function dayMatches(parsed: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = matchesField(parsed.dayOfMonth, dayOfMonth);
  const dowMatch = matchesField(parsed.dayOfWeek, dayOfWeek);

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    return true;
  }
  if (parsed.dayOfMonth.wildcard) {
    return dowMatch;
  }
  if (parsed.dayOfWeek.wildcard) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

function findNextCronTimeMs(parsed: ParsedCron, nowMs: number): number | undefined {
  const start = alignToNextMinute(nowMs);
  const maxChecks = 366 * 24 * 60;

  for (let i = 0; i < maxChecks; i++) {
    const candidateMs = start + i * 60_000;
    const parts = getDateParts(candidateMs, parsed.tz);

    if (!matchesField(parsed.minute, parts.minute)) continue;
    if (!matchesField(parsed.hour, parts.hour)) continue;
    if (!matchesField(parsed.month, parts.month)) continue;
    if (!dayMatches(parsed, parts.dayOfMonth, parts.dayOfWeek)) continue;

    return candidateMs;
  }

  return undefined;
}

function alignToNextMinute(nowMs: number): number {
  const date = new Date(nowMs + 60_000);
  date.setSeconds(0, 0);
  return date.getTime();
}

function getDateParts(
  timestampMs: number,
  timezone?: string,
): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  if (!timezone) {
    const date = new Date(timestampMs);
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    };
  }

  const formatter = getFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  let minute = 0;
  let hour = 0;
  let dayOfMonth = 0;
  let month = 0;
  let weekday = "";

  for (const part of parts) {
    switch (part.type) {
      case "minute":
        minute = Number.parseInt(part.value, 10);
        break;
      case "hour":
        hour = Number.parseInt(part.value, 10);
        break;
      case "day":
        dayOfMonth = Number.parseInt(part.value, 10);
        break;
      case "month":
        month = Number.parseInt(part.value, 10);
        break;
      case "weekday":
        weekday = part.value.slice(0, 3).toLowerCase();
        break;
      default:
        break;
    }
  }

  const dayOfWeek = WEEKDAY_TO_INT[weekday];
  if (dayOfWeek === undefined) {
    throw new Error(`Unsupported weekday value from timezone formatter: ${weekday}`);
  }

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone.trim();
  const existing = dtfCache.get(key);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: key,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  dtfCache.set(key, formatter);
  return formatter;
}
