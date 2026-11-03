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
