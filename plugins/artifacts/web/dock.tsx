import { useViewer } from "@pipoca/plugins/web";
import { useSyncExternalStore } from "react";

// Docked beside the page needs room for both.
const wide = "(width >= 1100px)";

// Tailwind's sm breakpoint, below which the viewer takes the phone layout.
const narrow = "(width < 40rem)";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  addEventListener("resize", listener);
  addEventListener("storage", listener);

  return () => {
    listeners.delete(listener);
    removeEventListener("resize", listener);
    removeEventListener("storage", listener);
  };
}

const keyOf = (person: string): string => `pipoca.artifacts.dock.${person}`;

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

// Whether the viewer opens beside the page instead of over it, as each
// person last chose, on windows wide enough for it.
export function useDock(): {
  readonly offered: boolean;
  readonly docked: boolean;
  readonly setDocked: (docked: boolean) => void;
} {
  const key = keyOf(useViewer().person.id);

  const offered = useMatches(wide);

  const chosen = useSyncExternalStore(subscribe, () => read(key));

  return {
    offered,
    docked: offered && chosen,
    setDocked: (docked) => {
      try {
        localStorage.setItem(key, docked ? "1" : "0");
      } catch {
        // Not remembered, as in a private window.
      }

      for (const listener of listeners) {
        listener();
      }
    },
  };
}

// Whether the window is phone-sized.
export function usePhone(): boolean {
  return useMatches(narrow);
}

function useMatches(query: string): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
