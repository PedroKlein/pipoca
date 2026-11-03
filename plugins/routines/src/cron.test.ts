import { expect, test } from "bun:test";
import { cronSchedule } from "./cron";

const iso = (at: number | undefined) =>
  at === undefined ? undefined : new Date(at).toISOString();

const next = (expression: string, after: string, zone = "UTC") =>
  iso(cronSchedule(expression, zone).next(Date.parse(after)));

test("fires on the next matching minute after the time", () => {
  expect(next("*/15 * * * *", "2026-11-03T08:07:30Z")).toBe(
    "2026-11-03T08:15:00.000Z",
  );

  expect(next("0 8 * * *", "2026-11-03T08:00:00Z")).toBe(
    "2026-11-04T08:00:00.000Z",
  );
});

test("reads weekdays, months and names", () => {
  expect(next("0 8 * * mon-fri", "2026-11-06T09:00:00Z")).toBe(
    "2026-11-09T08:00:00.000Z",
  );

  expect(next("30 6 1 jan *", "2026-11-03T00:00:00Z")).toBe(
    "2027-01-01T06:30:00.000Z",
  );

  expect(next("0 0 * * 7", "2026-11-03T00:00:00Z")).toBe(
    "2026-11-08T00:00:00.000Z",
  );
});

test("fires when either day field matches once both are restricted", () => {
  expect(next("0 0 13 * fri", "2026-11-03T00:00:00Z")).toBe(
    "2026-11-06T00:00:00.000Z",
  );
});

test("reads the time in the routine's zone, across a daylight saving change", () => {
  expect(next("0 8 * * *", "2026-10-24T12:00:00Z", "Europe/Berlin")).toBe(
    "2026-10-25T07:00:00.000Z",
  );

  expect(next("0 8 * * *", "2026-10-25T12:00:00Z", "Europe/Berlin")).toBe(
    "2026-10-26T07:00:00.000Z",
  );

  expect(next("0 8 * * *", "2026-10-23T12:00:00Z", "Europe/Berlin")).toBe(
    "2026-10-24T06:00:00.000Z",
  );

  expect(next("30 0 * * *", "2026-03-28T12:00:00Z", "Europe/Berlin")).toBe(
    "2026-03-28T23:30:00.000Z",
  );
});

test("has no firing for a date that never comes", () => {
  expect(next("0 0 30 2 *", "2026-11-03T00:00:00Z")).toBeUndefined();
});

test("says what is wrong with an expression or zone", () => {
  expect(() => cronSchedule("0 8 * *", "UTC")).toThrow("five fields");
  expect(() => cronSchedule("61 * * * *", "UTC")).toThrow("out of range");
  expect(() => cronSchedule("*/0 * * * *", "UTC")).toThrow("bad step");
  expect(() => cronSchedule("0 8 * * funday", "UTC")).toThrow("isn't a number");

  expect(() => cronSchedule("0 8 * * *", "Mars/Olympus")).toThrow(
    "isn't a time zone",
  );
});
