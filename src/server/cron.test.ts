import { expect, test } from "bun:test";
import { cronMatches, parseCron } from "./cron";

const at = (iso: string) => new Date(`${iso}Z`);
const fires = (cron: string, iso: string) => cronMatches(parseCron(cron), at(iso));

test("fields take numbers, lists, ranges, steps and names, in UTC", () => {
  expect(fires("30 5 * * *", "2026-11-06T05:30:00")).toBe(true);
  expect(fires("30 5 * * *", "2026-11-06T05:31:00")).toBe(false);
  expect(fires("30 5 * * *", "2026-11-06T05:30:59")).toBe(true);
  expect(fires("0,30 9-17 * * MON-FRI", "2026-11-06T17:30:00")).toBe(true); // a Friday
  expect(fires("0,30 9-17 * * MON-FRI", "2026-11-07T12:00:00")).toBe(false); // a Saturday
  expect(fires("*/15 * * * *", "2026-11-06T10:45:00")).toBe(true);
  expect(fires("*/15 * * * *", "2026-11-06T10:46:00")).toBe(false);
  expect(fires("5/20 * * * *", "2026-11-06T10:45:00")).toBe(true);
  expect(fires("0 0 1 jan,Jul *", "2026-07-01T00:00:00")).toBe(true);
  expect(fires("0 0 * * 7", "2026-11-08T00:00:00")).toBe(true); // 7 is Sunday too
  expect(fires("0 0 * * 0", "2026-11-08T00:00:00")).toBe(true);
});

test("with both day fields restricted, either one is enough, as in cron", () => {
  expect(fires("0 0 13 * FRI", "2026-11-13T00:00:00")).toBe(true);
  expect(fires("0 0 13 * FRI", "2026-11-06T00:00:00")).toBe(true); // a Friday, not the 13th
  expect(fires("0 0 13 * FRI", "2026-11-12T00:00:00")).toBe(false);
  expect(fires("0 0 13 * *", "2026-11-06T00:00:00")).toBe(false);
  // A day field that starts with * still counts as unrestricted, as in Vixie cron.
  expect(fires("0 0 */1 * MON", "2026-11-09T00:00:00")).toBe(true);
  expect(fires("0 0 */1 * MON", "2026-11-10T00:00:00")).toBe(false);
  expect(fires("0 0 */2 * FRI", "2026-11-13T00:00:00")).toBe(true); // an odd Friday
  expect(fires("0 0 */2 * FRI", "2026-11-06T00:00:00")).toBe(false); // an even Friday
  expect(fires("0 0 */2 * FRI", "2026-11-11T00:00:00")).toBe(false); // odd, but a Wednesday
});

test("what can't be read is refused with the reason, and so is anything more often than every five minutes", () => {
  for (const [cron, why] of [
    ["* * * *", "five fields"],
    ["60 * * * *", "outside 0-59"],
    ["0 24 * * *", "outside 0-23"],
    ["0 0 0 * *", "outside 1-31"],
    ["0 0 * 13 *", "outside 1-12"],
    ["0 0 * * FUNDAY", "isn't a number"],
    ["10-5 * * * *", "backwards"],
    ["*/0 * * * *", "isn't a step"],
    ["1/2/3 * * * *", "stray /"],
    ["* * * * *", "every 5 minutes"],
    ["*/2 * * * *", "every 5 minutes"],
    ["0,58 * * * *", "every 5 minutes"],
  ])
    expect(() => parseCron(cron), cron).toThrow(why);
  expect(() => parseCron("*/5 * * * *")).not.toThrow();
  expect(() => parseCron("0,55 * * * *")).not.toThrow();
});
