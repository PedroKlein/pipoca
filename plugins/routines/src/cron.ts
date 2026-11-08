// Five-field cron expressions (minute hour day-of-month month day-of-week)
// read in an IANA time zone, as crontab(5) defines them.

interface Fields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  // crontab(5): when both day fields are restricted, either one matching is
  // enough.
  readonly anyDay: boolean;
}

export interface Schedule {
  // The first firing strictly after the time, or undefined when none comes
  // within a few years, such as 30 February.
  readonly next: (after: number) => number | undefined;
}

const minuteMs = 60_000;
const searchDays = 4 * 366;

const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const names: readonly (readonly string[] | undefined)[] = [
  undefined,
  undefined,
  undefined,
  [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ],
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
];

// Throws an Error that says what is wrong with the expression or zone.
export function cronSchedule(expression: string, timeZone: string): Schedule {
  const fields = parse(expression);
  const zoned = wallClock(timeZone);

  return {
    next: (after) => {
      let at = Math.floor(after / minuteMs) * minuteMs + minuteMs;
      const end = at + searchDays * 24 * 60 * minuteMs;

      while (at < end) {
        const wall = zoned(at);

        // Hour by hour, since a day can have 23 or 25 of them.
        if (!dayMatches(fields, wall) || !fields.hours.has(wall.hour)) {
          at += (60 - wall.minute) * minuteMs;
          continue;
        }

        if (fields.minutes.has(wall.minute)) {
          return at;
        }

        at += minuteMs;
      }

      return undefined;
    },
  };
}

export interface TimeWindow {
  readonly contains: (at: number) => boolean;
  // When the window next opens, strictly after the time.
  readonly next: (after: number) => number | undefined;
}

// A window from one wall-clock time to another on the weekdays a cron
// weekday field names, such as mon-fri. One that ends at or before it
// starts runs past midnight into the next day.
export function timeWindow(
  days: string,
  from: string,
  to: string,
  timeZone: string,
): TimeWindow {
  const weekdays = field(days, 4);
  const start = minuteOfDay(from);
  const end = minuteOfDay(to);
  const zoned = wallClock(timeZone);

  if (weekdays.delete(7)) {
    weekdays.add(0);
  }

  const opens = cronSchedule(
    `${String(start % 60)} ${String(Math.floor(start / 60))} * * ${days}`,
    timeZone,
  );

  return {
    contains: (at) => {
      const wall = zoned(at);
      const minute = wall.hour * 60 + wall.minute;

      if (start < end) {
        return weekdays.has(wall.weekday) && minute >= start && minute < end;
      }

      return (
        (weekdays.has(wall.weekday) && minute >= start) ||
        (weekdays.has((wall.weekday + 6) % 7) && minute < end)
      );
    },
    next: opens.next,
  };
}

function minuteOfDay(text: string): number {
  const [, hours = "", minutes = ""] = /^(\d\d):(\d\d)$/.exec(text) ?? [];
  const minute = Number(hours) * 60 + Number(minutes);

  if (hours === "" || Number(minutes) > 59 || minute > 24 * 60) {
    throw new Error(`${text} isn't a time of day, such as 09:00`);
  }

  return minute;
}

// The day the time falls on in the zone, as YYYY-MM-DD.
export function dayOf(at: number, timeZone: string): string {
  const { year, month, day } = wallClock(timeZone)(at);

  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// When the day after the given one, YYYY-MM-DD, starts in the zone.
export function dayAfter(date: string, timeZone: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const midnight = Date.UTC(year, month - 1, day + 1);
  const zoned = wallClock(timeZone);
  let at = midnight;

  // Twice, since the zone's offset can differ at the first guess.
  for (let each = 0; each < 2; each++) {
    const wall = zoned(at);

    at +=
      midnight -
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  }

  return at;
}

function parse(expression: string): Fields {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(
      "a cron expression has five fields: minute hour day month weekday",
    );
  }

  const [minutes, hours, days, months, weekdays] = parts.map((part, at) =>
    field(part, at),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

  if (weekdays.delete(7)) {
    weekdays.add(0);
  }

  const [, , dayText = "*", , weekdayText = "*"] = parts;

  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: !dayText.startsWith("*") && !weekdayText.startsWith("*"),
  };
}

function field(text: string, at: number): Set<number> {
  const [low, high] = ranges[at] ?? [0, 0];
  const values = new Set<number>();

  for (const item of text.toLowerCase().split(",")) {
    const [span = "", stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`${item} has a bad step`);
    }

    const [from, to] = boundsOf(span, at, stepText !== undefined);

    if (
      from === undefined ||
      to === undefined ||
      from < low ||
      to > high ||
      from > to
    ) {
      throw new Error(`${item} is out of range ${String(low)}-${String(high)}`);
    }

    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }

  return values;
}

// A single value with a step runs to the end of the range, as 5/15 does.
function boundsOf(
  span: string,
  at: number,
  stepped: boolean,
): readonly (number | undefined)[] {
  const [low, high] = ranges[at] ?? [0, 0];

  if (span === "*") {
    return [low, high];
  }

  if (span.includes("-")) {
    return span.split("-").map((value) => valueOf(value, at));
  }

  return [valueOf(span, at), stepped ? high : valueOf(span, at)];
}

function valueOf(text: string, at: number): number {
  const named = names[at]?.indexOf(text) ?? -1;

  if (named >= 0) {
    return at === 3 ? named + 1 : named;
  }

  if (!/^\d+$/.test(text)) {
    throw new Error(`${text} isn't a number`);
  }

  return Number(text);
}

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

function wallClock(timeZone: string): (at: number) => Wall {
  let format: Intl.DateTimeFormat;

  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw new Error(`${timeZone} isn't a time zone, such as Europe/Berlin`);
  }

  const weekdays = names[4] ?? [];

  return (at) => {
    const parts = Object.fromEntries(
      format.formatToParts(at).map(({ type, value }) => [type, value]),
    );

    return {
      year: Number(parts["year"]),
      month: Number(parts["month"]),
      day: Number(parts["day"]),
      weekday: weekdays.indexOf(String(parts["weekday"]).toLowerCase()),
      hour: Number(parts["hour"]),
      minute: Number(parts["minute"]),
    };
  };
}

function dayMatches(fields: Fields, wall: Wall): boolean {
  if (!fields.months.has(wall.month)) {
    return false;
  }

  const day = fields.days.has(wall.day);
  const weekday = fields.weekdays.has(wall.weekday);

  return fields.anyDay ? day || weekday : day && weekday;
}
