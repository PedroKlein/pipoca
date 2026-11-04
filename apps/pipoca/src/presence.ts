import type { Presence } from "@pipoca/protocol";

type Listener = (people: readonly Presence[]) => void;

interface Room {
  // How many streams each person has open, in the order they came.
  readonly here: Map<string, number>;
  readonly typing: Map<string, ReturnType<typeof setTimeout>>;
  readonly listeners: Set<Listener>;
}

export interface Presences {
  // Whoever follows a Session's presence is looking at it until they stop.
  readonly join: (id: string, person: string, listener: Listener) => () => void;
  readonly typing: (id: string, person: string) => void;
}

// Who is looking at a team Session and who is typing in it (ADR 0054). It
// lives only in memory and keeps nothing.
export function presences(typingMs = 5000): Presences {
  const rooms = new Map<string, Room>();

  const people = ({ here, typing }: Room): readonly Presence[] =>
    [...here.keys()].map((person) => ({
      person,
      typing: typing.has(person),
    }));

  const tell = (room: Room): void => {
    const now = people(room);

    for (const listener of room.listeners) {
      listener(now);
    }
  };

  return {
    join: (id, person, listener) => {
      const room = rooms.get(id) ?? {
        here: new Map<string, number>(),
        typing: new Map<string, ReturnType<typeof setTimeout>>(),
        listeners: new Set<Listener>(),
      };

      rooms.set(id, room);
      room.here.set(person, (room.here.get(person) ?? 0) + 1);
      room.listeners.add(listener);
      tell(room);

      return () => {
        room.listeners.delete(listener);
        const open = (room.here.get(person) ?? 1) - 1;

        if (open > 0) {
          room.here.set(person, open);

          return;
        }

        room.here.delete(person);
        clearTimeout(room.typing.get(person));
        room.typing.delete(person);

        if (room.listeners.size === 0) {
          rooms.delete(id);
        } else {
          tell(room);
        }
      };
    },
    typing: (id, person) => {
      const room = rooms.get(id);

      if (room?.here.has(person) !== true) {
        return;
      }

      const was = room.typing.has(person);
      clearTimeout(room.typing.get(person));

      room.typing.set(
        person,
        setTimeout(() => {
          room.typing.delete(person);
          tell(room);
        }, typingMs),
      );

      if (!was) {
        tell(room);
      }
    },
  };
}
