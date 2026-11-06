interface Watcher {
  readonly topics: readonly string[];
  readonly onChange: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

// The part of a browser EventSource that watchChanges uses.
interface ChangeStream {
  readonly readyState: number;
  addEventListener(
    type: "open" | "error" | "message",
    listener: (event: { readonly data: string }) => void,
  ): void;
  close(): void;
}

const closedState = 2;

// A burst of changes, such as a turn starting and its title arriving,
// becomes one fetch.
const settleMs = 250;

const watchers = new Set<Watcher>();
let stream: ChangeStream | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function notify(watcher: Watcher): void {
  clearTimeout(watcher.timer);
  watcher.timer = setTimeout(watcher.onChange, settleMs);
}

// A browser reconnects by itself after the connection drops, but not after
// an error response, such as while the server restarts. Either way changes
// were missed, so watchers fetch again once the stream opens.
function connect(): void {
  const { EventSource } = globalThis as unknown as {
    EventSource: new (url: string) => ChangeStream;
  };

  const source = new EventSource("/api/changes");
  let lost = failures > 0;
  stream = source;

  source.addEventListener("message", (event) => {
    const { topic } = JSON.parse(event.data) as { topic: string };

    for (const watcher of watchers) {
      if (watcher.topics.includes(topic)) {
        notify(watcher);
      }
    }
  });

  source.addEventListener("error", () => {
    lost = true;

    if (source.readyState === closedState && stream === source) {
      void reconnect(source);
    }
  });

  source.addEventListener("open", () => {
    failures = 0;

    if (lost) {
      lost = false;
      watchers.forEach(notify);
    }
  });
}

// An EventSource doesn't say which error response closed it, and a signed
// out browser would otherwise retry forever.
async function reconnect(source: ChangeStream): Promise<void> {
  const status = await fetch("/api/changes").then(
    async (response) => {
      await response.body?.cancel();

      return response.status;
    },
    () => undefined,
  );

  if (stream !== source) {
    return;
  }

  if (status === 401) {
    (
      globalThis as unknown as { location: { reload: () => void } }
    ).location.reload();

    return;
  }

  retry = setTimeout(connect, Math.min(1000 * 2 ** failures, 30_000));
  failures++;
}

// Calls onChange when the server says one of the topics changed, and after
// the page reconnects, since changes sent while it was away are not resent
// (ADR 0038). One stream serves the whole page.
export function watchChanges(
  topics: readonly string[],
  onChange: () => void,
): () => void {
  const watcher: Watcher = { topics, onChange };
  watchers.add(watcher);

  if (stream === undefined) {
    connect();
  }

  return () => {
    clearTimeout(watcher.timer);
    watchers.delete(watcher);

    if (watchers.size === 0) {
      clearTimeout(retry);
      stream?.close();
      stream = undefined;
      failures = 0;
    }
  };
}
