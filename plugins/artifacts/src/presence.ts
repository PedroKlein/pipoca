import type { Clock, Timer } from "@pipoca/protocol";

const hereMs = 45_000;
const typingMs = 6000;

interface Seen {
  readonly person: string;
  readonly at: number;
  readonly typing: { readonly thread: string; readonly at: number } | null;
}

interface Beat {
  // One open page, so a person's other tabs keep them here when one closes.
  readonly page: string;
  readonly here: boolean;
  // The thread typed in, null once the person stopped, or left as it was.
  readonly typing?: string | null;
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
  readonly changed: () => void;
}): {
  readonly beat: (artifact: string, person: string, beat: Beat) => void;
  readonly list: (
    artifact: string,
  ) => readonly { readonly person: string; readonly typing: string | null }[];
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

  const people = (
    room: Map<string, Seen>,
  ): { readonly person: string; readonly typing: string | null }[] => {
    const typing = new Map<string, string | null>();

    for (const seen of room.values()) {
      typing.set(
        seen.person,
        seen.typing?.thread ?? typing.get(seen.person) ?? null,
      );
    }

    return [...typing].map(([person, thread]) => ({ person, typing: thread }));
  };

  const shape = (room: Map<string, Seen>): string =>
    JSON.stringify(people(room));

  const later = (artifact: string, ms: number): void => {
    const before = shape(live(artifact));

    timer.after(ms, async () => {
      if (shape(live(artifact)) !== before) {
        changed();
      }

      return Promise.resolve();
    });
  };

  return {
    beat: (artifact, person, { page, here, typing }) => {
      const room = live(artifact);
      const before = shape(room);
      const now = clock.now();
      const key = `${person}:${page}`;

      if (here) {
        let typed = room.get(key)?.typing ?? null;

        if (typing !== undefined) {
          typed = typing === null ? null : { thread: typing, at: now };
        }

        room.set(key, { person, at: now, typing: typed });

        rooms.set(artifact, room);
      } else {
        room.delete(key);
      }

      if (shape(room) !== before) {
        changed();
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
