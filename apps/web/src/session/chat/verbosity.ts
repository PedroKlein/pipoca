import { useEffect, useState } from "react";

// How much of a turn's tool activity the chat shows, chosen per browser like
// the theme. Quiet folds it to one live line, Normal keeps it open while the
// agent works, Verbose opens every step with its output.
export const verbosities = ["quiet", "normal", "verbose"] as const;

export type Verbosity = (typeof verbosities)[number];

const storageKey = "pipoca.verbosity";
const changed = new EventTarget();

function stored(): Verbosity {
  try {
    const value = localStorage.getItem(storageKey);

    return verbosities.find((each) => each === value) ?? "quiet";
  } catch {
    return "quiet";
  }
}

export function useVerbosity(): readonly [
  Verbosity,
  (verbosity: Verbosity) => void,
] {
  const [verbosity, setVerbosity] = useState(stored);

  useEffect(() => {
    const follow = (): void => {
      setVerbosity(stored());
    };

    changed.addEventListener("change", follow);
    addEventListener("storage", follow);

    return () => {
      changed.removeEventListener("change", follow);
      removeEventListener("storage", follow);
    };
  }, []);

  const choose = (next: Verbosity): void => {
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The choice lasts until the page reloads.
    }

    setVerbosity(next);
    changed.dispatchEvent(new Event("change"));
  };

  return [verbosity, choose];
}
