import { useMemo, useSyncExternalStore } from "react";

// What the address shows over the page, after a ? in its hash, such as an
// artifact: Back closes it and the link opens it again.
export interface Overlay {
  readonly params: URLSearchParams;
  // replace changes what's shown without a step for Back, such as another
  // version of the same artifact.
  readonly open: (
    params: Readonly<Record<string, string>>,
    options?: { readonly replace?: boolean },
  ) => void;
  readonly close: () => void;
}

const opened = "pipocaOverlay";

function subscribe(onChange: () => void): () => void {
  addEventListener("hashchange", onChange);

  return () => {
    removeEventListener("hashchange", onChange);
  };
}

function page(): string {
  return location.hash.split("?")[0] ?? "";
}

function open(
  params: Readonly<Record<string, string>>,
  { replace = false } = {},
): void {
  const target = `${page() || "#"}?${new URLSearchParams(params).toString()}`;

  if (replace) {
    history.replaceState(history.state, "", target);
    dispatchEvent(new HashChangeEvent("hashchange"));

    return;
  }

  location.hash = target;
  history.replaceState({ [opened]: true }, "");
}

// Back, when the app opened it; otherwise the page alone, such as after a
// link opened it in a new tab.
function close(): void {
  const state = history.state as Record<string, unknown> | null;

  if (state?.[opened] === true) {
    history.back();
  } else {
    history.replaceState(null, "", page() || location.pathname);
    dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

export function useOverlay(): Overlay {
  const hash = useSyncExternalStore(subscribe, () => location.hash);

  return useMemo(
    () => ({
      params: new URLSearchParams(hash.split("?")[1] ?? ""),
      open,
      close,
    }),
    [hash],
  );
}
