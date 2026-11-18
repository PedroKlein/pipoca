import { useApi, useLoaded } from "@pipoca/plugins/web";
import { useCallback, useEffect, useRef, useState } from "react";
import { artifacts as plugin } from "../plugin";
import type { Presence } from "../src/artifacts";

const beatMs = 20_000;
const typingMs = 3000;

// Who else is looking at the artifact, while this viewer says it's open
// too, and typing, which tells them at most every few seconds; null says
// the person stopped, such as once their reply is sent.
export function usePresence(id: string): {
  readonly people: readonly Presence[];
  readonly typing: (thread: string | null) => void;
} {
  const api = useApi(plugin);
  const [page] = useState(() => crypto.randomUUID());
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
          body: JSON.stringify({ page, here }),
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
  }, [api, id, page]);

  const typing = useCallback(
    (thread: string | null) => {
      const now = Date.now();

      if (thread !== null && now - said.current < typingMs) {
        return;
      }

      said.current = thread === null ? 0 : now;

      void api
        .post(`artifacts/${id}/presence`, { page, here: true, typing: thread })
        .catch(() => undefined);
    },
    [api, id, page],
  );

  return { people: value ?? [], typing };
}
