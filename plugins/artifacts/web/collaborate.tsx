import { href, useDraft } from "@pipoca/plugins/web";
import { cn } from "@pipoca/ui";
import { type ReactElement, useCallback, useEffect, useRef } from "react";
import { isHttpError, type TypedClient } from "@pipoca/plugins";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView } from "../src/artifacts";
import type { Span } from "../src/diff";

export const base = "/api/ext/artifacts";

// The link that opens an artifact alone in the window, and that people
// share. A version's link keeps showing that version.
export function artifactHref(id: string, version?: number): string {
  return href(
    plugin,
    version === undefined ? id : `${id}/v/${String(version)}`,
  );
}

// An artifact as the viewer and the chat's cards load it. A missing one was
// deleted or isn't shared with the person.
export async function loadArtifact(
  api: TypedClient,
  id: string,
): Promise<ArtifactView | "missing" | "failed"> {
  return api
    .get<ArtifactView>(`artifacts/${id}`)
    .catch((error: unknown) =>
      isHttpError(error) && error.status === 404 ? "missing" : "failed",
    );
}

const sandbox =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms";

// Where on the page a thread sits, numbered as the list numbers it; a
// draft has no number yet.
export interface Pin {
  readonly n: number | null;
  readonly quote: string;
  readonly selector: string;
  readonly active: boolean;
}

// Where something sits in the frame's window.
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// What a person picked to comment on: selected text, or in comment mode an
// element, named for people.
export type Picked =
  | { readonly quote: string; readonly rect: Box }
  | {
      readonly element: string;
      readonly label: string;
      readonly rect: Box;
    };

// The artifact in its sandbox. A page may ask for a draft in the Session's
// composer, which the person sends or not (ADR 0078); pages Pipoca draws
// also say what the person selected or clicked to comment on, and pin the
// threads.
export function Frame({
  artifact,
  version,
  commenting = false,
  pins,
  onPick,
  onPin,
  onEscape,
  changes,
  className,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  // Clicking an element picks it instead of following it.
  readonly commenting?: boolean;
  readonly pins?: readonly Pin[];
  readonly onPick?: (picked: Picked) => void;
  readonly onPin?: (n: number) => void;
  // Escape pressed in the page while commenting.
  readonly onEscape?: () => void;
  // Words this version took out or put in, compared with another, by where
  // they sit in a page text this long.
  readonly changes?:
    | {
        readonly kind: "removed" | "added";
        readonly length: number;
        readonly spans: readonly (Span & { readonly text: string })[];
      }
    | undefined;
  // Its size and edge, in place of a bordered box three quarters as tall as
  // the window.
  readonly className?: string;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const draft = useDraft();
  const { sessionId } = artifact;
  const steers = artifact.access === "steer";

  useEffect(() => {
    const heard = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        pipoca?: unknown;
        text?: unknown;
        selector?: unknown;
        label?: unknown;
        rect?: unknown;
        n?: unknown;
      } | null;

      if (data?.pipoca === "pin" && typeof data.n === "number") {
        onPin?.(data.n);

        return;
      }

      if (data?.pipoca === "escape") {
        onEscape?.();

        return;
      }

      const rect = boxOf(data?.rect);

      if (
        data?.pipoca === "element" &&
        typeof data.selector === "string" &&
        typeof data.label === "string" &&
        rect !== undefined
      ) {
        onPick?.({ element: data.selector, label: data.label, rect });

        return;
      }

      if (typeof data?.text !== "string") {
        return;
      }

      if (data.pipoca === "draft" && sessionId !== null && steers) {
        draft(sessionId, data.text);
      } else if (data.pipoca === "selection" && rect !== undefined) {
        onPick?.({ quote: data.text, rect });
      }
    };

    addEventListener("message", heard);

    return () => {
      removeEventListener("message", heard);
    };
  }, [draft, onEscape, onPick, onPin, sessionId, steers]);

  const pinned = JSON.stringify(pins ?? []);

  const tell = useCallback(() => {
    const window = frame.current?.contentWindow;

    window?.postMessage({ pipoca: "commenting", on: commenting }, "*");

    window?.postMessage(
      { pipoca: "pins", pins: JSON.parse(pinned) as unknown },
      "*",
    );
  }, [commenting, pinned]);

  useEffect(tell, [tell]);

  const markChanges = useCallback(() => {
    if (changes !== undefined) {
      frame.current?.contentWindow?.postMessage(
        { pipoca: "changes", ...changes },
        "*",
      );
    }
  }, [changes]);

  useEffect(markChanges, [markChanges]);

  return (
    <iframe
      ref={frame}
      key={`${artifact.id}-${String(version)}`}
      title={`${artifact.title}, version ${String(version)}`}
      src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}`}
      {...(artifact.kind !== "pdf" && { sandbox })}
      onLoad={() => {
        tell();
        markChanges();
      }}
      className={cn(
        "w-full shrink-0 bg-white",
        className ?? "h-[75vh] rounded-lg border border-line",
      )}
    />
  );
}

function boxOf(value: unknown): Box | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const { x, y, width, height } = value as Record<string, unknown>;

  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x, y, width, height }
    : undefined;
}
