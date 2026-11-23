import { frameSandbox, href, useDraft } from "@pipoca/plugins/web";
import { cn } from "@pipoca/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { isHttpError, type TypedClient } from "@pipoca/plugins";
import { artifacts as plugin } from "../plugin";
import { type ArtifactView, versionOf } from "../src/artifacts";
import type { Span } from "../src/diff";
import type { Outline } from "./doc";
import type { At, Slide } from "./slides";

export const base = "/api/ext/artifacts";

// The link that opens an artifact alone in the window, and that people
// share. A version's link keeps showing that version.
export function artifactHref(id: string, version?: number): string {
  return href(
    plugin,
    version === undefined ? id : `${id}/v/${String(version)}`,
  );
}

// The slide alone, following whoever presents the deck, for a second
// screen.
export function audienceHref(id: string): string {
  return href(plugin, `${id}/audience`);
}

const maxDraft = 4000;

// An artifact as the viewer and the chat's cards load it; the viewer marks
// it opened. A missing one was deleted or isn't shared with the person.
export async function loadArtifact(
  api: TypedClient,
  id: string,
  { opened = false }: { readonly opened?: boolean } = {},
): Promise<ArtifactView | "missing" | "failed"> {
  // The id comes from an address anyone can write, so it stays one segment
  // and the answer must be that artifact.
  return api
    .get<ArtifactView>(
      `artifacts/${encodeURIComponent(id)}${opened ? "?opened=1" : ""}`,
    )
    .then((view) => (view.id === id ? view : ("missing" as const)))
    .catch((error: unknown) =>
      isHttpError(error) && error.status === 404 ? "missing" : "failed",
    );
}

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
  badges = true,
  onPick,
  onPin,
  onEscape,
  onScroll,
  onOutline,
  goto,
  changes,
  slide,
  onDeck,
  onPinned,
  onKey,
  unseen = false,
  className,
  style,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  // Clicking an element picks it instead of following it.
  readonly commenting?: boolean;
  readonly pins?: readonly Pin[];
  // Numbered badges by the pins, unless cards beside the page number them.
  readonly badges?: boolean;
  readonly onPick?: (picked: Picked) => void;
  readonly onPin?: (n: number) => void;
  // Escape pressed in the page while commenting.
  readonly onEscape?: () => void;
  // How far the page scrolled, to keep what sits over it in place.
  readonly onScroll?: (by: { readonly x: number; readonly y: number }) => void;
  readonly onOutline?: (outline: Outline) => void;
  // The heading to scroll to, by its place in the outline, each time it's
  // asked anew.
  readonly goto?: { readonly section: number } | undefined;
  // Words this version took out or put in, compared with another, by where
  // they sit in a page text this long.
  readonly changes?:
    | {
        readonly kind: "removed" | "added";
        readonly length: number;
        readonly spans: readonly (Span & { readonly text: string })[];
      }
    | undefined;
  readonly slide?: At | undefined;
  readonly onDeck?: (deck: {
    readonly slides: readonly Slide[];
    readonly duration: string;
  }) => void;
  readonly onPinned?: (
    pins: readonly { readonly n: number; readonly slide: number }[],
  ) => void;
  readonly onKey?: (key: string) => void;
  // Drawn out of sight only to hear what the page reports.
  readonly unseen?: boolean;
  // Its size and edge, in place of a bordered box three quarters as tall as
  // the window.
  readonly className?: string;
  readonly style?: CSSProperties;
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
        x?: unknown;
        y?: unknown;
        sections?: unknown;
        tops?: unknown;
        scrolled?: unknown;
        slides?: unknown;
        duration?: unknown;
        pins?: unknown;
        key?: unknown;
      } | null;

      if (data?.pipoca === "deck") {
        onDeck?.({
          slides: slidesOf(data.slides),
          duration:
            typeof data.duration === "string" ? data.duration.slice(0, 20) : "",
        });

        return;
      }

      if (data?.pipoca === "pinned") {
        onPinned?.(pinnedOf(data.pins));

        return;
      }

      if (data?.pipoca === "key" && typeof data.key === "string") {
        onKey?.(data.key);

        return;
      }

      if (data?.pipoca === "outline") {
        onOutline?.({
          ...outlineOf(data.sections, data.tops),
          scrolled: finite(data.scrolled) ? data.scrolled : 0,
        });

        return;
      }

      if (data?.pipoca === "pin" && typeof data.n === "number") {
        onPin?.(data.n);

        return;
      }

      if (data?.pipoca === "escape") {
        onEscape?.();

        return;
      }

      if (
        data?.pipoca === "scroll" &&
        typeof data.x === "number" &&
        typeof data.y === "number"
      ) {
        onScroll?.({ x: data.x, y: data.y });

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

      // Only just after the person clicked or typed in the page, so it
      // can't write their message behind their back.
      if (
        data.pipoca === "draft" &&
        sessionId !== null &&
        steers &&
        document.activeElement === frame.current &&
        navigator.userActivation.isActive &&
        data.text.length <= maxDraft
      ) {
        draft(sessionId, data.text);
      } else if (data.pipoca === "selection" && rect !== undefined) {
        onPick?.({ quote: data.text, rect });
      }
    };

    addEventListener("message", heard);

    return () => {
      removeEventListener("message", heard);
    };
  }, [
    draft,
    onDeck,
    onEscape,
    onKey,
    onOutline,
    onPick,
    onPin,
    onPinned,
    onScroll,
    sessionId,
    steers,
  ]);

  useEffect(() => {
    if (goto !== undefined) {
      frame.current?.contentWindow?.postMessage(
        { pipoca: "goto", section: goto.section },
        "*",
      );
    }
  }, [goto]);

  // Pinning redraws the page, so only for pins that changed.
  const pinned = JSON.stringify(pins ?? []);

  const tell = useCallback(() => {
    const window = frame.current?.contentWindow;

    window?.postMessage({ pipoca: "commenting", on: commenting }, "*");

    window?.postMessage(
      { pipoca: "pins", pins: JSON.parse(pinned) as unknown, badges },
      "*",
    );
  }, [badges, commenting, pinned]);

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

  const showSlide = useCallback(() => {
    if (slide !== undefined) {
      frame.current?.contentWindow?.postMessage(
        { pipoca: "slide", slide: slide.slide, step: slide.step },
        "*",
      );
    }
  }, [slide]);

  useEffect(showSlide, [showSlide]);

  return (
    <iframe
      ref={frame}
      key={`${artifact.id}-${String(version)}`}
      title={`${artifact.title}, ${frameName(artifact, version)}`}
      src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}`}
      {...(artifact.kind !== "pdf" && { sandbox: frameSandbox })}
      {...(unseen && { "aria-hidden": true, tabIndex: -1 })}
      onLoad={() => {
        tell();
        markChanges();
        showSlide();
      }}
      className={cn(
        "w-full shrink-0 bg-canvas",
        className ?? "h-[75vh] rounded-lg border border-line",
      )}
      style={style}
    />
  );
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const shownSections = 200;
const shownPins = 500;

// What a page said of its headings, kept to what's well formed and to as
// many as are drawn: the page is the artifact's, not Pipoca's.
function outlineOf(
  sections: unknown,
  tops: unknown,
): Omit<Outline, "scrolled"> {
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.slice(0, shownPins).filter(finite) : [];

  return {
    sections: (Array.isArray(sections)
      ? sections.slice(0, shownSections)
      : []
    ).flatMap((each: unknown) => {
      const { text, level, threads } = (each ?? {}) as Record<string, unknown>;

      return typeof text === "string" && finite(level)
        ? [
            {
              text: text.slice(0, 80),
              level: Math.min(4, Math.max(1, Math.round(level))),
              threads: numbers(threads),
            },
          ]
        : [];
    }),
    tops: (Array.isArray(tops) ? tops.slice(0, shownPins) : []).flatMap(
      (each: unknown) => {
        const { n, top } = (each ?? {}) as Record<string, unknown>;

        return finite(n) && Number.isInteger(n) && finite(top)
          ? [{ n, top }]
          : [];
      },
    ),
  };
}

const shownSlides = 500;

function slidesOf(value: unknown): Slide[] {
  return (Array.isArray(value) ? value.slice(0, shownSlides) : []).flatMap(
    (each: unknown) => {
      const { selector, title, notes, steps } = (each ?? {}) as Record<
        string,
        unknown
      >;

      return typeof selector === "string" &&
        typeof title === "string" &&
        typeof notes === "string" &&
        finite(steps)
        ? [
            {
              selector: selector.slice(0, 4000),
              title: title.slice(0, 80),
              notes: notes.slice(0, 5000),
              steps: Math.min(shownSlides, Math.max(0, Math.round(steps))),
            },
          ]
        : [];
    },
  );
}

function pinnedOf(value: unknown): { n: number; slide: number }[] {
  return (Array.isArray(value) ? value.slice(0, shownPins) : []).flatMap(
    (each: unknown) => {
      const { n, slide } = (each ?? {}) as Record<string, unknown>;

      return finite(n) &&
        Number.isInteger(n) &&
        finite(slide) &&
        Number.isInteger(slide)
        ? [{ n, slide }]
        : [];
    },
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

function frameName(artifact: ArtifactView, save: number): string {
  if (!artifact.living) {
    return `version ${String(save)}`;
  }

  if (save === artifact.versions) {
    return "latest";
  }

  const number = versionOf(artifact, save);

  return number === null ? "an earlier edit" : `version ${String(number)}`;
}
