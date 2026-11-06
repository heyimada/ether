// POSIX cron as `on: schedule` uses it on GitHub: five fields (minute, hour, day of month, month, day of week),
// always in UTC. Fields take `*`, numbers, `a-b` ranges, `,` lists and `/n` steps; months and weekdays also take
// their English abbreviations (JAN, MON), and 7 is Sunday as well as 0. Pure, so it can be tested without a clock.

export type Cron = { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const FIELDS = [
  { name: "minute", min: 0, max: 59, names: null },
  { name: "hour", min: 0, max: 23, names: null },
  { name: "day of month", min: 1, max: 31, names: null },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS },
] as const;

// As on GitHub, no workflow runs more often than this.
export const MIN_INTERVAL_MINUTES = 5;

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const fail = (why: string): never => {
    throw new Error(`"${text}" isn't a valid ${f.name}: ${why}`);
  };
  const value = (part: string): number => {
    const named = f.names ? (f.names as readonly string[]).indexOf(part.toUpperCase()) : -1;
    if (named !== -1) return named + (f.name === "month" ? 1 : 0);
    if (!/^\d{1,2}$/.test(part)) fail(`"${part}" isn't a number`);
    const n = Number(part);
    if (n < f.min || n > f.max) fail(`${n} is outside ${f.min}-${f.max}`);
    return n;
  };
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === "") fail("it has a stray /");
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) === 0) fail(`"/${stepText}" isn't a step`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [f.min, f.max];
    else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) fail(`"${range}" isn't a range`);
      [from, to] = [value(a), value(b)];
      if (from > to) fail(`${range} runs backwards`);
    } else {
      from = value(range);
      // `5/15` means from 5 on, as `5-59/15`.
      to = stepText === undefined ? from : f.max;
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  // Sunday is 0 and 7.
  if (f.name === "day of week" && out.delete(7)) out.add(0);
  return out;
}

export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || text.length > 200) throw new Error(`"${text}" must have five fields: minute, hour, day of month, month and day of week`);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]));
  const sorted = [...minutes].sort((a, b) => a - b);
  const gaps = sorted.map((m, i) => (i === sorted.length - 1 ? sorted[0] + 60 : sorted[i + 1]) - m);
  // A single minute in each hour is fine; several are only if they're far enough apart, across the hour too.
  if (sorted.length > 1 && Math.min(...gaps) < MIN_INTERVAL_MINUTES) throw new Error(`"${text}" runs more often than every ${MIN_INTERVAL_MINUTES} minutes, which is the shortest interval`);
  // As in Vixie cron, a day field that starts with * (*/2 too) counts as unrestricted for the rule below.
  return { minutes, hours, days, months, weekdays, anyDay: parts[2].startsWith("*"), anyWeekday: parts[4].startsWith("*") };
}

// Whether the cron fires in the minute `at` falls in (UTC). As in cron, when both day fields are restricted,
// either one matching is enough.
export function cronMatches(c: Cron, at: Date): boolean {
  if (!c.minutes.has(at.getUTCMinutes()) || !c.hours.has(at.getUTCHours()) || !c.months.has(at.getUTCMonth() + 1)) return false;
  const day = c.days.has(at.getUTCDate());
  const weekday = c.weekdays.has(at.getUTCDay());
  return c.anyDay || c.anyWeekday ? day && weekday : day || weekday;
}
