import { sseResponse } from "@pipoca/protocol";

// Tells open pages that something of a kind changed, never what, so each
// fetches it as usual (ADR 0038).
export interface Changes {
  readonly publish: (topic: string) => void;
  readonly stream: () => Response;
}

export function changeFeed(): Changes {
  const listeners = new Set<(topic: string) => void>();

  return {
    publish: (topic) => {
      for (const listener of listeners) {
        listener(topic);
      }
    },
    stream: () =>
      sseResponse((send) => {
        const listener = (topic: string): void => {
          send({ topic });
        };

        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      }),
  };
}
