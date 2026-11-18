import type { Clock, Timer } from "@pipoca/protocol";

const hereMs = 45_000;
const typingMs = 6000;

interface Seen {
  readonly at: number;
  readonly typing: { readonly thread: string; readonly at: number } | null;
}

export interface Presences {
  // A page says every so often that it's open, and in which thread its
  // person types; here false says it closed.
  readonly beat: (
    artifact: string,
    person: string,
    beat: { readonly here: boolean; readonly typing?: string },
  ) => void;
  readonly list: (
    artifact: string,
  ) => readonly { readonly person: string; readonly typing: string | null }[];
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
}): Presences {
  const rooms = new Map<string, Map<string, Seen>>();

  const live = (artifact: string): Map<string, Seen> => {
    const room = rooms.get(artifact) ?? new Map<string, Seen>();
    const now = clock.now();

    for (const [person, seen] of room) {
      if (now - seen.at >= hereMs) {
        room.delete(person);
      } else if (seen.typing !== null && now - seen.typing.at >= typingMs) {
        room.set(person, { ...seen, typing: null });
      }
    }

    if (room.size === 0) {
      rooms.delete(artifact);
    }

    return room;
  };

  const shape = (room: Map<string, Seen>): string =>
    JSON.stringify(
      [...room].map(([person, seen]) => [person, seen.typing?.thread]),
    );

  const later = (artifact: string, ms: number): void => {
    const before = shape(live(artifact));

    timer.after(ms, async () => {
      await Promise.resolve();

      if (shape(live(artifact)) !== before) {
        changed();
      }
    });
  };

  return {
    beat: (artifact, person, { here, typing }) => {
      const room = live(artifact);
      const before = shape(room);
      const now = clock.now();

      if (here) {
        room.set(person, {
          at: now,
          typing: typing === undefined ? null : { thread: typing, at: now },
        });

        rooms.set(artifact, room);
      } else {
        room.delete(person);
      }

      if (shape(room) !== before) {
        changed();
      }

      if (here) {
        later(artifact, typing === undefined ? hereMs : typingMs);
      }
    },
    list: (artifact) =>
      [...live(artifact)].map(([person, seen]) => ({
        person,
        typing: seen.typing?.thread ?? null,
      })),
  };
}
