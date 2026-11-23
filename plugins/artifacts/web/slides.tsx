import { isHttpError } from "@pipoca/plugins";
import { errorText } from "@pipoca/protocol";
import { frameSandbox, useApi, useLoaded, useNow } from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Icon,
  Menu,
  type MenuItem,
  TextArea,
  useConfirm,
} from "@pipoca/ui";
import {
  type CSSProperties,
  type DragEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView } from "../src/artifacts";
import { audienceHref, base, Frame, loadArtifact } from "./collaborate";
import { useSize } from "./size";

export interface Slide {
  readonly selector: string;
  readonly title: string;
  readonly notes: string;
  readonly steps: number;
}

export interface At {
  readonly slide: number;
  readonly step: number;
}

export interface Presenting extends At {
  readonly version: number;
  readonly blank: boolean;
  readonly by: string;
  readonly yours: boolean;
  readonly since: number;
}

const width = 1280;
const height = 720;
const beatMs = 20_000;

const forward = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "click"]);
const back = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);
export const deckKeys = new Set([...forward, ...back, "Home", "End"]);
const presenterKeys = new Set([...deckKeys, "b", "B", "s", "S", "Escape"]);

export function moved(
  slides: readonly Slide[],
  at: At,
  key: string,
): At | undefined {
  const last = slides.length - 1;
  const steps = (slide: number): number => slides[slide]?.steps ?? 0;

  if (forward.has(key)) {
    if (at.step < steps(at.slide)) {
      return { slide: at.slide, step: at.step + 1 };
    }

    return at.slide < last ? { slide: at.slide + 1, step: 0 } : at;
  }

  if (back.has(key)) {
    if (at.step > 0) {
      return { slide: at.slide, step: at.step - 1 };
    }

    return at.slide > 0
      ? { slide: at.slide - 1, step: steps(at.slide - 1) }
      : at;
  }

  if (key === "Home") {
    return { slide: 0, step: 0 };
  }

  return key === "End" ? { slide: last, step: steps(last) } : undefined;
}

export function within(slides: readonly Slide[], at: At): At {
  const slide = Math.max(0, Math.min(at.slide, slides.length - 1));

  return {
    slide,
    step: Math.max(0, Math.min(at.step, slides[slide]?.steps ?? 0)),
  };
}

// A talk's length as a deck gives it: 15m, 1h 30m, 900s, 15:00 or 15, in
// seconds.
export function lengthOf(duration: string): number | undefined {
  const text = duration.trim().toLowerCase();
  const clocked = /^(\d+):([0-5]\d)$/.exec(text);

  if (clocked !== null) {
    return Number(clocked[1]) * 60 + Number(clocked[2]) || undefined;
  }

  if (/^\d+$/.test(text)) {
    return Number(text) * 60 || undefined;
  }

  const spelled =
    /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(text);

  if (spelled === null) {
    return undefined;
  }

  const [, hours = "0", minutes = "0", seconds = "0"] = spelled;

  return (
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) || undefined
  );
}

export function slideName(slides: readonly Slide[], slide: number): string {
  const title = slides[slide]?.title ?? "";

  return `Slide ${String(slide + 1)}${title === "" ? "" : ` · ${title}`}`;
}

export function typing(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable], [role=menu], dialog dialog",
    ) !== null
  );
}

function Scaled({
  className,
  style,
  children,
}: {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children: (scale: number) => ReactNode;
}): ReactElement {
  const [measured, size] = useSize();

  return (
    <div
      ref={measured}
      style={style}
      className={cn("relative aspect-video overflow-hidden", className)}
    >
      {children(size.width === 0 ? 1 : size.width / width)}
    </div>
  );
}

const scaled = (scale: number): CSSProperties => ({
  position: "absolute",
  top: 0,
  left: 0,
  width,
  height,
  transform: `scale(${String(scale)})`,
  transformOrigin: "0 0",
});

function Thumb({
  artifact,
  version,
  slide,
  className,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly slide: number;
  readonly className?: string;
}): ReactElement {
  return (
    <Scaled className={cn("rounded-sm bg-canvas", className)}>
      {(scale) => (
        <iframe
          // Another slide gets a new frame: moving this one to another
          // #slide would add a step to the window's history, which Back and
          // Escape would then take instead of closing the viewer.
          key={slide}
          title={`Slide ${String(slide + 1)}`}
          aria-hidden
          tabIndex={-1}
          loading="lazy"
          sandbox={frameSandbox}
          src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}#slide=${String(slide)}`}
          className="pointer-events-none border-0 bg-canvas"
          style={scaled(scale)}
        />
      )}
    </Scaled>
  );
}

function Count({ n }: { readonly n: number }): ReactElement | null {
  if (n === 0) {
    return null;
  }

  return (
    <span
      aria-label={`${String(n)} ${n === 1 ? "comment" : "comments"}`}
      className="absolute -top-2 -right-2 grid size-4.5 place-items-center rounded-[9px_9px_9px_2px] bg-butter text-[10px] font-semibold text-on-butter"
    >
      {n}
    </span>
  );
}

export function DeckView({
  artifact,
  version,
  slides,
  at,
  counts,
  onGo,
  onKey,
  stage,
  writing,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly slides: readonly Slide[];
  readonly at: At;
  readonly counts: ReadonlyMap<number, number>;
  readonly onGo: (slide: number) => void;
  readonly onKey: (key: string) => void;
  readonly stage: (style: CSSProperties) => ReactElement;
  readonly writing: (
    area: { readonly width: number; readonly height: number },
    scale: number,
  ) => ReactNode;
}): ReactElement {
  const [column, room] = useSize();
  const [box, area] = useSize();
  const notes = slides[at.slide]?.notes ?? "";

  const fits =
    room.width === 0
      ? 900
      : Math.max(
          240,
          Math.min(900, room.width - 56, ((room.height - 200) * 16) / 9),
        );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {slides.length > 0 && (
        <nav
          aria-label="Slides"
          className="flex w-42 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line px-3 py-3.5 max-sm:hidden"
        >
          {slides.map((slide, n) => (
            <button
              key={`${String(n)}:${slide.selector}`}
              type="button"
              aria-label={slideName(slides, n)}
              aria-current={n === at.slide ? "true" : undefined}
              className="flex cursor-pointer gap-1.5 text-left text-caption text-fg-dim aria-current:font-semibold aria-current:text-fg-strong"
              onClick={() => {
                onGo(n);
              }}
            >
              {n + 1}
              <span
                className={cn(
                  "relative flex-1 rounded-sm",
                  n === at.slide
                    ? "outline-2 outline-offset-2 outline-accent"
                    : "border border-line",
                )}
              >
                <Thumb artifact={artifact} version={version} slide={n} />
                <Count n={counts.get(n) ?? 0} />
              </span>
            </button>
          ))}
        </nav>
      )}
      <div
        ref={column}
        className="flex min-w-0 flex-1 flex-col items-center gap-4 overflow-y-auto px-7 py-6 max-sm:px-3 max-sm:py-3"
      >
        <div ref={box} className="relative w-full" style={{ maxWidth: fits }}>
          <Scaled className="rounded-md bg-canvas shadow-card">
            {(scale) => (
              <>
                {stage(scaled(scale))}
                {writing(area, scale)}
              </>
            )}
          </Scaled>
        </div>
        {slides.length > 0 && (
          <div
            className="flex w-full items-center gap-2 sm:hidden"
            style={{ maxWidth: fits }}
          >
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Previous slide"
              onClick={() => {
                onKey("ArrowLeft");
              }}
            >
              <Icon name="chevron-left" className="size-3.5" />
            </Button>
            <span className="flex-1 text-center text-caption text-fg-dim">
              Slide {at.slide + 1} of {slides.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Next slide"
              onClick={() => {
                onKey("ArrowRight");
              }}
            >
              <Icon name="chevron-right" className="size-3.5" />
            </Button>
          </div>
        )}
        <section
          aria-label="Speaker notes"
          className="flex w-full flex-col gap-1.5"
          style={{ maxWidth: fits }}
        >
          <h3 className="text-caption font-medium text-fg-dim">
            Speaker notes
          </h3>
          <p
            className={cn(
              "text-prose whitespace-pre-line",
              notes === "" ? "text-fg-dim" : "text-fg",
            )}
          >
            {notes === "" ? "This slide has no notes." : notes}
          </p>
        </section>
      </div>
    </div>
  );
}

const asks = [
  { label: "Make it shorter", body: "Make this slide shorter." },
  { label: "Split into two slides", body: "Split this slide into two." },
  {
    label: "Add a chart from the data",
    body: "Add a chart to this slide from the data in the Session.",
  },
] as const;

export function SlideGrid({
  artifact,
  version,
  slides,
  at,
  counts,
  askable,
  onOpen,
  onAsk,
  onExport,
  exporting,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly slides: readonly Slide[];
  readonly at: At;
  readonly counts: ReadonlyMap<number, number>;
  readonly askable: boolean;
  readonly onOpen: (slide: number) => void;
  readonly onAsk: (slide: number | null, body: string) => Promise<void>;
  readonly onExport: (as: Export) => void;
  readonly exporting: boolean;
}): ReactElement {
  const [writing, setWriting] = useState<number | null>();
  const [confirm, confirming] = useConfirm();
  const [dragged, setDragged] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const count = slides.length;

  const ask = (slide: number | null, body: string): void => {
    setProblem(undefined);

    void onAsk(slide, body).catch((error: unknown) => {
      setProblem(errorText(error));
    });
  };

  const items = (n: number): MenuItem[] => [
    ...asks.map(({ label, body }) => ({
      label,
      run: () => {
        ask(n, body);
      },
    })),
    {
      label: "Something else…",
      run: () => {
        setWriting(n);
      },
    },
    ...(n > 0
      ? [
          {
            label: "Move earlier",
            icon: "chevron-left" as const,
            divided: true,
            run: () => {
              ask(n, `Move this slide so it becomes slide ${String(n)}.`);
            },
          },
        ]
      : []),
    ...(n < count - 1
      ? [
          {
            label: "Move later",
            icon: "chevron-right" as const,
            divided: n === 0,
            run: () => {
              ask(n, `Move this slide so it becomes slide ${String(n + 2)}.`);
            },
          },
        ]
      : []),
    {
      label: "Duplicate",
      divided: true,
      run: () => {
        ask(n, "Duplicate this slide, right after it.");
      },
    },
    {
      label: "Delete slide",
      icon: "trash",
      danger: true,
      run: () => {
        void confirm({
          title: `Ask Pi to delete slide ${String(n + 1)}?`,
          description:
            "Pi deletes it in a new version. Earlier versions keep it.",
          confirm: "Ask Pi to delete it",
          danger: true,
        }).then((yes) => {
          if (yes) {
            ask(n, "Delete this slide.");
          }
        });
      },
    },
  ];

  const dropped = (event: DragEvent, n: number): void => {
    event.preventDefault();

    if (dragged !== undefined && dragged !== n) {
      ask(dragged, `Move this slide so it becomes slide ${String(n + 1)}.`);
    }

    setDragged(undefined);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4.5 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onOpen(at.slide);
          }}
        >
          <Icon name="chevron-left" className="size-3.5" />
          Back to slide {at.slide + 1}
        </Button>
        <span className="flex-1 text-caption text-fg-dim">
          {count} {count === 1 ? "slide" : "slides"}
          {askable && count > 1 && (
            <span className="pointer-coarse:hidden max-sm:hidden">
              {" "}
              · drag to reorder
            </span>
          )}
        </span>
        <Menu
          label="Export"
          variant="default"
          size="sm"
          align="end"
          trigger={
            <>
              Export
              <Icon name="chevron-down" className="size-3.5" />
            </>
          }
          items={exportItems(onExport, { busy: exporting })}
        />
      </div>
      {problem !== undefined && (
        <div className="border-b border-line px-4.5 py-2">
          <ErrorText size="caption">{problem}</ErrorText>
        </div>
      )}
      <ul
        aria-label="All slides"
        className="grid flex-1 grid-cols-4 content-start gap-5 overflow-y-auto px-7 py-6 max-lg:grid-cols-3 max-sm:grid-cols-2 max-sm:gap-3 max-sm:px-3 max-sm:py-3"
      >
        {slides.map((slide, n) => {
          const comments = counts.get(n) ?? 0;

          return (
            <li
              key={`${String(n)}:${slide.selector}`}
              draggable={askable}
              aria-label={slideName(slides, n)}
              className={cn(
                "flex min-w-0 flex-col gap-1.5",
                dragged === n && "opacity-50",
              )}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragged(n);
              }}
              onDragEnd={() => {
                setDragged(undefined);
              }}
              onDragOver={(event) => {
                if (dragged !== undefined) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                dropped(event, n);
              }}
            >
              <button
                type="button"
                aria-label={`Open ${slideName(slides, n)}`}
                className={cn(
                  "cursor-pointer rounded-md",
                  n === at.slide
                    ? "outline-2 outline-offset-2 outline-accent"
                    : "border border-line",
                )}
                onClick={() => {
                  onOpen(n);
                }}
              >
                <Thumb
                  artifact={artifact}
                  version={version}
                  slide={n}
                  className="rounded-md"
                />
              </button>
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-caption text-fg-dim">
                  {[
                    ...(comments === 0
                      ? []
                      : [
                          `${String(comments)} ${comments === 1 ? "comment" : "comments"}`,
                        ]),
                    String(n + 1),
                    ...(slide.title === "" ? [] : [slide.title]),
                  ].join(" · ")}
                </span>
                {askable && (
                  <Menu
                    label={`${slideName(slides, n)}, ask Pi`}
                    heading={`Ask Pi about slide ${String(n + 1)}`}
                    size="sm"
                    items={items(n)}
                  />
                )}
              </div>
            </li>
          );
        })}
        {askable && (
          <li className="flex">
            <button
              type="button"
              className="grid aspect-video w-full cursor-pointer place-items-center rounded-md border border-dashed border-line-strong text-label font-medium text-fg-dim hover:bg-hover"
              onClick={() => {
                setWriting(null);
              }}
            >
              Ask Pi for a slide
            </button>
          </li>
        )}
      </ul>
      <AskDialog
        open={writing !== undefined}
        title={
          writing === null || writing === undefined
            ? "Ask Pi for a slide"
            : `Ask Pi about slide ${String(writing + 1)}`
        }
        onClose={() => {
          setWriting(undefined);
        }}
        onAsk={async (body) => {
          const slide = writing ?? null;

          await onAsk(
            slide,
            slide === null ? `Add a slide at the end: ${body}` : body,
          );

          setWriting(undefined);
        }}
      />
      {confirming}
    </div>
  );
}

export type Export = "pdf" | "notes" | "png";

// What a deck exports to, as the grid's Export lists it, or as More does
// beside the artifact's other actions.
export function exportItems(
  onExport: (as: Export) => void,
  { more = false, busy = false }: { more?: boolean; busy?: boolean } = {},
): MenuItem[] {
  const item = (as: Export, label: string): MenuItem => ({
    label,
    icon: "download",
    disabled: busy,
    run: () => {
      onExport(as);
    },
  });

  return more
    ? [
        item("pdf", "Export as PDF"),
        item("notes", "Export as PDF with notes"),
        item("png", "Export slide as PNG"),
      ]
    : [
        item("pdf", "PDF, one page per slide"),
        item("notes", "PDF with speaker notes"),
        item("png", "PNG of this slide"),
        {
          label: "PowerPoint (not planned)",
          disabled: true,
          run: () => undefined,
        },
      ];
}

function AskDialog({
  open,
  title,
  onAsk,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onAsk: (body: string) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      description="Sent to Pi as a comment on the deck. Only Pi edits slides."
    >
      <AskForm key={title} onAsk={onAsk} onClose={onClose} />
    </Dialog>
  );
}

function AskForm({
  onAsk,
  onClose,
}: {
  readonly onAsk: (body: string) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(undefined);

        void onAsk(body.trim())
          .catch((error: unknown) => {
            setProblem(errorText(error));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <DialogBody>
        <Field label="What should Pi do?">
          <TextArea
            value={body}
            rows={3}
            required
            autoFocus
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </Field>
        <ErrorText size="caption">{problem}</ErrorText>
      </DialogBody>
      <DialogFoot>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || body.trim() === ""}
        >
          Send to Pi
        </Button>
      </DialogFoot>
    </form>
  );
}

export type Job = { readonly notes: boolean } | { readonly slide: number };

// A deck drawn out of sight to print it, or one slide of it to save as a
// picture.
const drawMs = 30_000;
const pngBytes = 20 * 1024 * 1024;
const pngData = "data:image/png;base64,";
const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The bytes of the PNG a page drew, what's wrong with it, or nothing when
// it isn't a picture at all.
function pictureOf(url: unknown): Uint8Array<ArrayBuffer> | string | undefined {
  if (typeof url !== "string" || !url.startsWith(pngData)) {
    return undefined;
  }

  if (((url.length - pngData.length) * 3) / 4 > pngBytes) {
    return "The picture of the slide is over 20 MB.";
  }

  let bytes: Uint8Array<ArrayBuffer>;

  try {
    bytes = Uint8Array.from(atob(url.slice(pngData.length)), (each) =>
      each.charCodeAt(0),
    );
  } catch {
    return "The picture of the slide didn't decode.";
  }

  return pngMagic.every((each, at) => bytes[at] === each)
    ? bytes
    : "The picture of the slide isn't a PNG.";
}

export function DeckJob({
  artifact,
  version,
  job,
  onDone,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly job: Job;
  readonly onDone: (problem?: string) => void;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const heard = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        pipoca?: unknown;
        url?: unknown;
        error?: unknown;
      } | null;

      if (data?.pipoca === "printed") {
        onDone();
      } else if (data?.pipoca === "png" && "slide" in job) {
        const bytes = pictureOf(data.url);

        if (typeof bytes === "string") {
          onDone(bytes);
        } else if (bytes !== undefined) {
          // A browser names a download only from a link of its own origin.
          const link = document.createElement("a");

          const href = URL.createObjectURL(
            new Blob([bytes], { type: "image/png" }),
          );

          link.href = href;
          link.download = `${artifact.title} slide ${String(job.slide + 1)}.png`;
          link.click();

          setTimeout(() => {
            URL.revokeObjectURL(href);
          }, 60_000);

          onDone();
        } else {
          onDone(
            typeof data.error === "string"
              ? data.error.slice(0, 300)
              : "The slide couldn't be drawn as a picture.",
          );
        }
      }
    };

    addEventListener("message", heard);

    const late =
      "slide" in job
        ? setTimeout(() => {
            onDone("The slide took too long to draw.");
          }, drawMs)
        : undefined;

    return () => {
      removeEventListener("message", heard);
      clearTimeout(late);
    };
  }, [artifact.title, job, onDone]);

  return (
    <iframe
      ref={frame}
      title={"slide" in job ? "Drawing the slide" : "Printing the deck"}
      aria-hidden
      tabIndex={-1}
      sandbox={frameSandbox}
      src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}${"slide" in job ? `#slide=${String(job.slide)}` : ""}`}
      className="pointer-events-none fixed top-0 -left-[200vw] border-0"
      style={{ width, height }}
      onLoad={() => {
        frame.current?.contentWindow?.postMessage(
          "slide" in job ? { pipoca: "png" } : { pipoca: "print", ...job },
          "*",
        );
      }}
    />
  );
}

export function usePresenting(id: string, deck: boolean): Presenting | null {
  const api = useApi(plugin);

  const { value } = useLoaded(
    async () =>
      deck
        ? api
            .get<{
              presenting: Presenting | null;
            }>(`artifacts/${id}/presenting`)
            .then(({ presenting }) => presenting)
            .catch(() => null)
        : null,
    `${id}:presenting:${String(deck)}`,
    { changes: [`presence-${id}`] },
  );

  return value ?? null;
}

// Tells everyone the slide shown while this page presents, until it ends.
// Each call waits for the one before, so an ending is never followed by a
// late move, and a refusal stops until the slide changes.
export function useShared(
  id: string,
  shown:
    (At & { readonly version: number; readonly blank: boolean }) | undefined,
): string | undefined {
  const api = useApi(plugin);
  const [page] = useState(() => crypto.randomUUID());
  const queue = useRef(Promise.resolve());
  const [problem, setProblem] = useState<{ on: string; text: string }>();

  const on =
    shown === undefined
      ? ""
      : `${String(shown.version)}:${String(shown.slide)}:${String(shown.step)}:${String(shown.blank)}`;

  const live = shown !== undefined;

  const send = useCallback((run: () => Promise<void>) => {
    queue.current = queue.current.then(run).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!live) {
      return undefined;
    }

    const [version = "1", slide = "0", step = "0", blank = "false"] =
      on.split(":");

    let over = false;

    const share = (): void => {
      send(async () => {
        if (over) {
          return;
        }

        try {
          await api.put(`artifacts/${id}/presenting`, {
            page,
            version: Number(version),
            slide: Number(slide),
            step: Number(step),
            blank: blank === "true",
          });

          setProblem(undefined);
        } catch (error) {
          setProblem({ on, text: errorText(error) });

          if (isHttpError(error) && error.status < 500) {
            over = true;
            clearInterval(every);
          }
        }
      });
    };

    const every = setInterval(share, beatMs);

    share();

    return () => {
      over = true;
      clearInterval(every);
    };
  }, [api, id, live, on, page, send]);

  useEffect(() => {
    if (!live) {
      return undefined;
    }

    return () => {
      send(async () => {
        await api
          .delete(`artifacts/${id}/presenting?page=${page}`)
          .catch(() => undefined);
      });
    };
  }, [api, id, live, page, send]);

  return live ? problem?.text : undefined;
}

// Keeps what's behind the presenter out of reach of the keyboard and
// screen readers while it's open, and hands focus back where it was.
function useModal(): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shown = root.current;

    if (shown === null) {
      return undefined;
    }

    const before = document.activeElement;
    const quieted: Element[] = [];

    for (
      let at: Element = shown;
      at !== document.body && at.parentElement !== null;
      at = at.parentElement
    ) {
      for (const sibling of at.parentElement.children) {
        if (sibling !== at && !sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          quieted.push(sibling);
        }
      }
    }

    shown.focus();

    return () => {
      for (const each of quieted) {
        each.removeAttribute("inert");
      }

      if (before instanceof HTMLElement) {
        before.focus();
      }
    };
  }, []);

  return root;
}

export function Presenter({
  artifact,
  version,
  slides,
  at,
  blank,
  duration,
  following,
  asked,
  problem,
  onKey,
  onBlank,
  onEnd,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly slides: readonly Slide[];
  readonly at: At;
  readonly blank: boolean;
  readonly duration: string;
  readonly following: number;
  readonly asked: readonly {
    readonly id: string;
    readonly author: string;
    readonly slide: number | undefined;
    readonly body: string;
  }[];
  readonly problem: string | undefined;
  readonly onKey: (key: string) => void;
  readonly onBlank: (blank: boolean) => void;
  readonly onEnd: () => void;
}): ReactElement {
  const [started] = useState(Date.now);
  const now = useNow(1000);
  const [alone, setAlone] = useState(false);
  const [room, size] = useSize();
  const dialog = useModal();
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const total = lengthOf(duration);
  const next = at.slide + 1 < slides.length ? at.slide + 1 : undefined;
  const notes = slides[at.slide]?.notes ?? "";

  const key = (pressed: string): void => {
    if (pressed === "Escape") {
      onEnd();
    } else if (pressed === "b" || pressed === "B") {
      onBlank(!blank);
    } else if (pressed === "s" || pressed === "S") {
      setAlone(!alone);
    } else {
      onKey(pressed);
    }
  };

  useEffect(() => {
    const pressed = (event: KeyboardEvent): void => {
      if (
        !presenterKeys.has(event.key) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target) ||
        (event.key === " " &&
          event.target instanceof Element &&
          event.target.closest("button, a") !== null)
      ) {
        return;
      }

      event.preventDefault();
      key(event.key);
    };

    document.addEventListener("keydown", pressed, true);

    return () => {
      document.removeEventListener("keydown", pressed, true);
    };
  });

  const fits =
    size.width === 0
      ? undefined
      : Math.min(size.width, ((size.height - (alone ? 0 : 44)) * 16) / 9);

  const stage = (
    <Scaled
      className={cn(
        "shrink-0 bg-canvas",
        alone ? "max-md:w-full!" : "rounded-md max-md:w-full!",
      )}
      {...(fits !== undefined && { style: { width: fits } })}
    >
      {(scale) => (
        <>
          <Frame
            artifact={artifact}
            version={version}
            slide={at}
            onKey={key}
            className="border-0"
            style={scaled(scale)}
          />
          {blank && (
            <div
              role="img"
              aria-label="Blank screen"
              className="absolute inset-0 bg-blank"
            />
          )}
        </>
      )}
    </Scaled>
  );

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label="Presenter view"
      tabIndex={-1}
      data-theme="dark"
      className={cn(
        "fixed inset-0 z-40 flex flex-col text-fg outline-none",
        alone
          ? "items-center justify-center bg-blank"
          : "gap-4.5 bg-bg px-7 py-6 max-sm:px-3 max-sm:py-3",
      )}
    >
      {alone ? (
        <div ref={room} className="flex size-full items-center justify-center">
          {stage}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3.5">
            <h2 className="min-w-0 flex-1 truncate text-title text-fg-strong max-sm:basis-full max-sm:whitespace-normal">
              {artifact.title}
            </h2>
            <span className="flex items-baseline gap-1.5">
              <span
                role="timer"
                aria-label="Time presenting"
                className={cn(
                  "font-mono text-[22px] font-medium",
                  total !== undefined && elapsed > total
                    ? "text-failed"
                    : "text-fg-strong",
                )}
              >
                {clock(elapsed)}
              </span>
              {total !== undefined && (
                <span className="font-mono text-label text-fg-dim">
                  of {clock(total)}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1 text-label text-fg">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  problem === undefined ? "bg-done" : "bg-failed",
                )}
              />
              {problem ?? `${String(following)} following in Pipoca`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                open(audienceHref(artifact.id), "_blank", "popup");
              }}
            >
              <Icon name="monitor" className="size-3.5" />
              Open audience window
            </Button>
            <Button size="sm" onClick={onEnd}>
              End
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 gap-5 max-md:flex-col">
            <div
              ref={room}
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 max-md:flex-none"
            >
              {stage}
              <div
                className="flex flex-wrap items-center gap-2.5 max-md:w-full!"
                {...(fits !== undefined && { style: { width: fits } })}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Previous slide"
                  onClick={() => {
                    onKey("ArrowLeft");
                  }}
                >
                  <Icon name="chevron-left" className="size-3.5" />
                </Button>
                <span className="text-caption text-fg-dim">
                  Slide {at.slide + 1} of {slides.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Next slide"
                  onClick={() => {
                    onKey("ArrowRight");
                  }}
                >
                  <Icon name="chevron-right" className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={blank}
                  className="aria-pressed:bg-hover aria-pressed:text-fg-strong"
                  onClick={() => {
                    onBlank(!blank);
                  }}
                >
                  Blank
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAlone(true);
                  }}
                >
                  Slide only
                </Button>
                <span className="flex-1" />
                <span className="text-caption text-fg-dim max-sm:hidden">
                  ← → move · B blank · S slide only · Esc ends
                </span>
              </div>
            </div>
            <aside
              aria-label="Presenter"
              className="flex w-85 shrink-0 flex-col gap-3.5 overflow-y-auto max-md:w-full"
            >
              <h3 className="text-caption font-medium text-fg-dim">Next</h3>
              {next === undefined ? (
                <p className="text-label text-fg-dim">
                  This is the last slide.
                </p>
              ) : (
                <Thumb artifact={artifact} version={version} slide={next} />
              )}
              <h3 className="text-caption font-medium text-fg-dim">Notes</h3>
              <p className="text-[17px] leading-relaxed whitespace-pre-line text-fg-strong">
                {notes === "" ? "This slide has no notes." : notes}
              </p>
              <span className="flex-1" />
              {asked.length > 0 && (
                <section
                  aria-label="Asked while you present"
                  className={cn(cardClass, "flex flex-col gap-1.5 p-3")}
                >
                  <h3 className="text-caption font-medium text-fg-dim">
                    Asked while you present · {asked.length}
                  </h3>
                  {asked.slice(-3).map((each) => (
                    <p key={each.id} className="text-label">
                      <b className="font-semibold">{each.author}</b>
                      {each.slide === undefined
                        ? ""
                        : ` on slide ${String(each.slide + 1)}`}
                      : {each.body}
                    </p>
                  ))}
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

// The slide alone, as the people in the room see it on a second screen,
// following whoever presents.
export function Audience({ id }: { readonly id: string }): ReactElement {
  const api = useApi(plugin);
  const [slides, setSlides] = useState<readonly Slide[]>([]);
  const [room, size] = useSize();

  const { value } = useLoaded(
    async () => loadArtifact(api, id),
    `${id}:audience`,
    { changes: ["artifacts"] },
  );

  const live = usePresenting(id, true);
  const at = within(slides, live ?? { slide: 0, step: 0 });

  const fits =
    size.width === 0 ? undefined : Math.min(size.width, (size.height * 16) / 9);

  return (
    <div
      ref={room}
      data-theme="dark"
      className="fixed inset-0 flex items-center justify-center bg-blank text-fg"
    >
      {typeof value === "object" ? (
        <Scaled
          className="w-full bg-canvas"
          {...(fits !== undefined && { style: { width: fits } })}
        >
          {(scale) => (
            <>
              <Frame
                artifact={value}
                version={Math.min(
                  live?.version ?? value.versions,
                  value.versions,
                )}
                slide={at}
                onDeck={(deck) => {
                  setSlides(deck.slides);
                }}
                className="border-0"
                style={scaled(scale)}
              />
              {live?.blank === true && (
                <div
                  role="img"
                  aria-label="Blank screen"
                  className="absolute inset-0 bg-blank"
                />
              )}
            </>
          )}
        </Scaled>
      ) : (
        <p className="text-label text-fg-dim">
          {value === undefined ? "Loading…" : "This deck isn't here."}
        </p>
      )}
    </div>
  );
}

function clock(seconds: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");

  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
