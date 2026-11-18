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
        .post(`artifacts/${id}/presence`, { here })
        .catch(() => undefined);
    };

    beat(true);

    const every = setInterval(() => {
      beat(true);
    }, beatMs);

    return () => {
      clearInterval(every);
      beat(false);
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
