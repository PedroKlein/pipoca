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

// An address's page, and what it shows over the page after a ?.
export function hashParts(hash: string): {
  readonly page: string;
  readonly over: string | undefined;
} {
  const at = hash.indexOf("?");

  return at === -1
    ? { page: hash, over: undefined }
    : { page: hash.slice(0, at), over: hash.slice(at + 1) };
}

function page(): string {
  return hashParts(location.hash).page;
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

  if (location.hash === target) {
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
    history.replaceState(
      null,
      "",
      page() || `${location.pathname}${location.search}`,
    );

    dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

export function useOverlay(): Overlay {
  const hash = useSyncExternalStore(subscribe, () => location.hash);

  return useMemo(
    () => ({
      params: new URLSearchParams(hashParts(hash).over ?? ""),
      open,
      close,
    }),
    [hash],
  );
}
