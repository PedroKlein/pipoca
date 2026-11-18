import { useApi, useLoaded } from "@pipoca/plugins/web";
import { useCallback, useEffect, useRef } from "react";
import { artifacts as plugin } from "../plugin";
import type { Presence } from "../src/artifacts";

const beatMs = 20_000;
const typingMs = 3000;

// Who else is looking at the artifact, while this viewer says it's open
// too, and typing, which tells them at most every few seconds.
export function usePresence(id: string): {
  readonly people: readonly Presence[];
  readonly typing: (thread: string) => void;
} {
  const api = useApi(plugin);
  const said = useRef(0);

  const { value } = useLoaded(
    async () =>
      api
        .get<{ people: Presence[] }>(`artifacts/${id}/presence`)
        .then(({ people }) => people)
        .catch((): Presence[] => []),
    `${id}:presence`,
    { changes: ["presence"] },
  );

  useEffect(() => {
    const beat = (here: boolean): void => {
      void api
        .raw(`artifacts/${id}/presence`, {
          method: "POST",
          body: JSON.stringify({ here }),
          // Still sent while the page closes.
          keepalive: !here,
        })
        .catch(() => undefined);
    };

    const leave = (): void => {
      beat(false);
    };

    // Back from the browser's page cache, after leaving said goodbye.
    const back = (): void => {
      beat(true);
    };

    beat(true);

    const every = setInterval(() => {
      beat(true);
    }, beatMs);

    addEventListener("pagehide", leave);
    addEventListener("pageshow", back);

    return () => {
      clearInterval(every);
      removeEventListener("pagehide", leave);
      removeEventListener("pageshow", back);
      leave();
    };
  }, [api, id]);

  const typing = useCallback(
    (thread: string) => {
      const now = Date.now();

      if (now - said.current < typingMs) {
        return;
      }

      said.current = now;

      void api
        .post(`artifacts/${id}/presence`, { here: true, typing: thread })
        .catch(() => undefined);
    },
    [api, id],
  );

  return { people: value ?? [], typing };
}
