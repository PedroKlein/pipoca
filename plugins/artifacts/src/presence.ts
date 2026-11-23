import type { Clock, Timer } from "@pipoca/protocol";

// Long enough for a background tab, whose timers the browser slows to once
// a minute.
const hereMs = 90_000;
const pagesEach = 10;
const typingMs = 6000;

interface Seen {
  readonly person: string;
  readonly at: number;
  readonly typing: { readonly thread: string; readonly at: number } | null;
  readonly following: boolean;
}

interface Looking {
  readonly person: string;
  readonly typing: string | null;
  readonly following: boolean;
}

interface Beat {
  // One open page, so a person's other tabs keep them here when one closes.
  readonly page: string;
  readonly here: boolean;
  // The thread typed in, null once the person stopped, or left as it was.
  readonly typing?: string | null;
  readonly following?: boolean;
}

// Who is looking at each artifact and typing in which thread. It lives
// only in memory, and changed hears whenever that changes, also when
// someone falls silent.
export function presences({
  clock,
  timer,
  changed,
}: {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly changed: (artifact: string) => void;
}): {
  readonly beat: (artifact: string, person: string, beat: Beat) => void;
  readonly list: (artifact: string) => readonly Looking[];
} {
  const rooms = new Map<string, Map<string, Seen>>();

  const live = (artifact: string): Map<string, Seen> => {
    const room = rooms.get(artifact) ?? new Map<string, Seen>();
    const now = clock.now();

    for (const [page, seen] of room) {
      if (now - seen.at >= hereMs) {
        room.delete(page);
      } else if (seen.typing !== null && now - seen.typing.at >= typingMs) {
        room.set(page, { ...seen, typing: null });
      }
    }

    if (room.size === 0) {
      rooms.delete(artifact);
    }

    return room;
  };

  const people = (room: Map<string, Seen>): Looking[] => {
    const found = new Map<string, Looking>();

    for (const seen of room.values()) {
      const was = found.get(seen.person);

      found.set(seen.person, {
        person: seen.person,
        typing: seen.typing?.thread ?? was?.typing ?? null,
        following: seen.following || (was?.following ?? false),
      });
    }

    return [...found.values()];
  };

  const shape = (room: Map<string, Seen>): string =>
    JSON.stringify(people(room));

  const later = (artifact: string, ms: number): void => {
    const before = shape(live(artifact));

    timer.after(ms, async () => {
      if (shape(live(artifact)) !== before) {
        changed(artifact);
      }

      return Promise.resolve();
    });
  };

  return {
    beat: (artifact, person, { page, here, typing, following }) => {
      const room = live(artifact);
      const before = shape(room);
      const now = clock.now();
      const key = `${person}:${page}`;

      // A stop that arrives after the page left doesn't bring it back.
      if (typing === null && !room.has(key)) {
        return;
      }

      if (here) {
        let typed = room.get(key)?.typing ?? null;

        if (typing !== undefined) {
          typed = typing === null ? null : { thread: typing, at: now };
        }

        const follows = following ?? room.get(key)?.following ?? false;

        room.delete(key);
        room.set(key, { person, at: now, typing: typed, following: follows });

        const theirs = [...room].filter(([, seen]) => seen.person === person);

        for (const [stale] of theirs.slice(0, -pagesEach)) {
          room.delete(stale);
        }

        rooms.set(artifact, room);
      } else {
        room.delete(key);
      }

      if (shape(room) !== before) {
        changed(artifact);
      }

      if (here) {
        later(artifact, hereMs);
      }

      if (typeof typing === "string") {
        later(artifact, typingMs);
      }
    },
    list: (artifact) => people(live(artifact)),
  };
}

export interface Presented {
  readonly person: string;
  readonly page: string;
  readonly version: number;
  readonly slide: number;
  readonly step: number;
  readonly blank: boolean;
  readonly since: number;
}

export function presentations({
  clock,
  timer,
  changed,
}: {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly changed: (artifact: string) => void;
}): {
  readonly move: (
    artifact: string,
    shown: Omit<Presented, "since">,
    over: boolean,
  ) => boolean;
  readonly end: (
    artifact: string,
    by: { readonly person: string; readonly page: string },
    over: boolean,
  ) => boolean;
  readonly drop: (artifact: string) => void;
  readonly get: (artifact: string) => Presented | undefined;
} {
  const decks = new Map<string, Presented & { readonly at: number }>();

  const get = (artifact: string): Presented | undefined => {
    const found = decks.get(artifact);

    if (found !== undefined && clock.now() - found.at >= hereMs) {
      decks.delete(artifact);

      return undefined;
    }

    return found;
  };

  const drop = (artifact: string): void => {
    if (decks.delete(artifact)) {
      changed(artifact);
    }
  };

  return {
    move: (artifact, shown, over) => {
      const was = get(artifact);

      if (was !== undefined && was.person !== shown.person && !over) {
        return false;
      }

      const at = clock.now();

      decks.set(artifact, {
        ...shown,
        since: was?.person === shown.person ? was.since : at,
        at,
      });

      changed(artifact);

      timer.after(hereMs, async () => {
        if (decks.get(artifact)?.at === at && get(artifact) === undefined) {
          changed(artifact);
        }

        return Promise.resolve();
      });

      return true;
    },
    end: (artifact, { person, page }, over) => {
      const was = get(artifact);

      if (was === undefined) {
        return true;
      }

      if (was.person === person ? was.page === page : over) {
        drop(artifact);

        return true;
      }

      return was.person === person;
    },
    drop,
    get,
  };
}
