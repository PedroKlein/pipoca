import { errorText } from "@pipoca/protocol";
import { frameSandbox, useApi } from "@pipoca/plugins/web";
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Icon,
  type IconName,
  Segmented,
  Tabs,
  TextArea,
} from "@pipoca/ui";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView } from "../src/artifacts";
import {
  type Canvas,
  type CanvasBoard,
  type CanvasNote,
  type CanvasView,
  peopleColors,
  type Sticky,
  type StickyColor,
  stickyWidth,
} from "../src/canvas";
import { base } from "./collaborate";
import type { Thread } from "./comments";
import { useSize } from "./size";

export type BoardMode = "board" | "play";

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Spot {
  readonly page: string | undefined;
  readonly camera: Camera | undefined;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const minZoom = 0.05;
const maxZoom = 4;
const step = 1.25;
const nudge = 40;
const stickyHeight = 160;

const stickyClass: Readonly<Record<StickyColor, string>> = {
  yellow: "bg-sticky-yellow",
  pink: "bg-sticky-pink",
  green: "bg-sticky-green",
  blue: "bg-sticky-blue",
};

const headingClass: Readonly<Record<number, string>> = {
  1: "text-[72px]",
  2: "text-[48px]",
  3: "text-[36px]",
};

const colorNames: Readonly<Record<StickyColor, string>> = {
  yellow: "Yellow",
  pink: "Pink",
  green: "Green",
  blue: "Blue",
};

const clamp = (z: number): number => Math.min(maxZoom, Math.max(minZoom, z));

export function boardSrc(
  artifact: ArtifactView,
  version: number,
  file: string,
): string {
  return `${base}/artifacts/${artifact.id}/view?v=${String(version)}&path=${encodeURIComponent(file)}`;
}

function bounds(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) {
    return undefined;
  }

  const left = Math.min(...boxes.map(({ x }) => x));
  const top = Math.min(...boxes.map(({ y }) => y));
  const right = Math.max(...boxes.map(({ x, w }) => x + w));
  const bottom = Math.max(...boxes.map(({ y, h }) => y + h));

  return { x: left, y: top, w: right - left, h: bottom - top };
}

function fitted(
  box: Box | undefined,
  room: { readonly width: number; readonly height: number },
): Camera {
  if (box === undefined || room.width === 0) {
    return { x: 40, y: 40, z: 1 };
  }

  const pad = 48;

  const z = clamp(
    Math.min(
      1,
      (room.width - pad * 2) / Math.max(1, box.w),
      (room.height - pad * 2) / Math.max(1, box.h),
    ),
  );

  return {
    z,
    x: (room.width - box.w * z) / 2 - box.x * z,
    y: (room.height - box.h * z) / 2 - box.y * z,
  };
}

function zoomed(
  camera: Camera,
  by: number,
  at: { readonly x: number; readonly y: number },
): Camera {
  const z = clamp(camera.z * by);
  const k = z / camera.z;

  return {
    z,
    x: at.x - (at.x - camera.x) * k,
    y: at.y - (at.y - camera.y) * k,
  };
}

export function boardsOn(canvas: Canvas, page: string): readonly CanvasBoard[] {
  return canvas.boards.filter((each) => each.page === page);
}

export function boardCounts(
  threads: readonly Thread[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const { top } of threads) {
    if (!top.resolved && top.file !== "") {
      counts.set(top.file, (counts.get(top.file) ?? 0) + 1);
    }
  }

  return counts;
}

function Tag({
  children,
  pi = false,
  label,
}: {
  readonly children: ReactNode;
  readonly pi?: boolean;
  readonly label?: string;
}): ReactElement {
  return (
    <span
      {...(label !== undefined && { "aria-label": label })}
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[11px] leading-4.5 font-medium",
        pi ? "bg-butter text-on-butter" : "bg-hover text-fg-dim",
      )}
    >
      {children}
    </span>
  );
}

export function CanvasPane({
  artifact,
  version,
  view,
  threads,
  canComment,
  spot,
  onSpot,
  onOpen,
  onChanged,
  commenting,
  onCommenting,
  writing,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly view: CanvasView;
  readonly threads: readonly Thread[];
  readonly canComment: boolean;
  readonly spot: Spot;
  readonly onSpot: (spot: Spot) => void;
  readonly onOpen: (board: string, mode: BoardMode) => void;
  readonly onChanged: () => void;
  readonly commenting: boolean;
  readonly onCommenting: (commenting: boolean) => void;
  // The box for a comment on the whole canvas, while one is written.
  readonly writing?:
    | ((area: { readonly width: number; readonly height: number }) => ReactNode)
    | undefined;
}): ReactElement {
  const { canvas } = view;

  if (canvas === null) {
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-2 bg-panel p-8 text-center"
      >
        <p className="font-semibold text-fg-strong">
          This canvas can&apos;t be drawn
        </p>
        <p className="max-w-xl text-label text-fg-dim">{view.error}</p>
        <p className="max-w-xl text-label text-fg-dim">
          Pi heard what&apos;s wrong when it published. Ask it to fix
          canvas.json, or open its Files.
        </p>
      </div>
    );
  }

  return (
    <Drawn
      artifact={artifact}
      version={version}
      view={view}
      canvas={canvas}
      threads={threads}
      canComment={canComment}
      spot={spot}
      onSpot={onSpot}
      onOpen={onOpen}
      onChanged={onChanged}
      commenting={commenting}
      onCommenting={onCommenting}
      writing={writing}
    />
  );
}

function Drawn({
  artifact,
  version,
  view,
  canvas,
  threads,
  canComment,
  spot,
  onSpot,
  onOpen,
  onChanged,
  commenting,
  onCommenting,
  writing,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly view: CanvasView;
  readonly canvas: Canvas;
  readonly threads: readonly Thread[];
  readonly canComment: boolean;
  readonly spot: Spot;
  readonly onSpot: (spot: Spot) => void;
  readonly onOpen: (board: string, mode: BoardMode) => void;
  readonly onChanged: () => void;
  readonly commenting: boolean;
  readonly onCommenting: (commenting: boolean) => void;
  readonly writing:
    | ((area: { readonly width: number; readonly height: number }) => ReactNode)
    | undefined;
}): ReactElement {
  const api = useApi(plugin);

  const page =
    canvas.pages.find(({ id }) => id === spot.page)?.id ?? canvas.launch;

  const boards = boardsOn(canvas, page);
  const notes = canvas.notes.filter((each) => each.page === page);
  const stickies = view.stickies.filter((each) => each.page === page);

  const lost = view.stickies.filter(
    (each) => !canvas.pages.some(({ id }) => id === each.page),
  );

  const counts = boardCounts(threads);
  const [measured, room] = useSize();
  const surface = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<Sticky | "new">();
  const [moved, setMoved] = useState<{ id: string; x: number; y: number }>();
  const [problem, setProblem] = useState<string>();

  const box = bounds([
    ...boards,
    ...notes.map((each) => ({ ...each, h: stickyHeight })),
    ...stickies.map((each) => ({ ...each, w: 360, h: stickyHeight })),
  ]);

  const narrow = room.width < 640;
  const camera = spot.camera ?? fitted(narrow ? (boards[0] ?? box) : box, room);

  const setCamera = (next: Camera): void => {
    onSpot({ page, camera: next });
  };

  const fit = (): void => {
    onSpot({ page, camera: undefined });
  };

  const centre = { x: room.width / 2, y: room.height / 2 };

  const grid =
    20 * camera.z * 2 ** Math.max(0, Math.ceil(Math.log2(0.6 / camera.z)));

  const wheel = useEffectEvent((event: WheelEvent, rect: DOMRect): void => {
    if (event.ctrlKey || event.metaKey) {
      setCamera(
        zoomed(camera, Math.exp(-event.deltaY * 0.01), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    } else {
      setCamera({
        ...camera,
        x: camera.x - event.deltaX,
        y: camera.y - event.deltaY,
      });
    }
  });

  useEffect(() => {
    const element = surface.current;

    if (element === null) {
      return undefined;
    }

    const wheeled = (event: WheelEvent): void => {
      event.preventDefault();
      wheel(event, element.getBoundingClientRect());
    };

    element.addEventListener("wheel", wheeled, { passive: false });

    return () => {
      element.removeEventListener("wheel", wheeled);
    };
  }, []);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  // Focus that comes from a pointer is where the person looks already.
  const pointing = useRef(false);
  const nudging = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const done = (): void => {
      pointing.current = false;
    };

    addEventListener("pointerup", done);
    addEventListener("pointercancel", done);

    return () => {
      removeEventListener("pointerup", done);
      removeEventListener("pointercancel", done);
      clearTimeout(nudging.current);
    };
  }, []);

  const reveal = (shown: Box): void => {
    surface.current?.scrollTo(0, 0);

    if (pointing.current) {
      return;
    }

    const left = camera.x + shown.x * camera.z;
    const top = camera.y + shown.y * camera.z;

    if (
      left >= 0 &&
      top >= 0 &&
      left + shown.w * camera.z <= room.width &&
      top + shown.h * camera.z <= room.height
    ) {
      return;
    }

    setCamera({
      ...camera,
      x: room.width / 2 - (shown.x + shown.w / 2) * camera.z,
      y: room.height / 2 - (shown.y + shown.h / 2) * camera.z,
    });
  };

  const down = (event: PointerEvent<HTMLDivElement>): void => {
    pointing.current = true;

    if (
      event.target instanceof Element &&
      event.target.closest("[data-mine], [data-tools]") !== null
    ) {
      return;
    }

    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    start.current = { x: event.clientX, y: event.clientY };
    dragged.current = false;
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const was = pointers.current.get(event.pointerId);

    if (was === undefined) {
      return;
    }

    const now = { x: event.clientX, y: event.clientY };

    const others = [...pointers.current.entries()].filter(
      ([id]) => id !== event.pointerId,
    );

    const other = others[0]?.[1];

    if (
      !dragged.current &&
      other === undefined &&
      Math.hypot(now.x - start.current.x, now.y - start.current.y) <= 3
    ) {
      return;
    }

    if (!dragged.current) {
      dragged.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    pointers.current.set(event.pointerId, now);

    if (other === undefined) {
      setCamera({
        ...camera,
        x: camera.x + now.x - was.x,
        y: camera.y + now.y - was.y,
      });

      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const before = Math.hypot(was.x - other.x, was.y - other.y);
    const after = Math.hypot(now.x - other.x, now.y - other.y);

    if (before > 0) {
      setCamera(
        zoomed(camera, after / before, {
          x: (now.x + other.x) / 2 - rect.left,
          y: (now.y + other.y) / 2 - rect.top,
        }),
      );
    }
  };

  const up = (event: PointerEvent<HTMLDivElement>): void => {
    pointing.current = false;
    pointers.current.delete(event.pointerId);
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const panned: Record<string, readonly [number, number]> = {
      ArrowLeft: [nudge, 0],
      ArrowRight: [-nudge, 0],
      ArrowUp: [0, nudge],
      ArrowDown: [0, -nudge],
    };

    const by = panned[event.key];

    if (by !== undefined) {
      setCamera({ ...camera, x: camera.x + by[0], y: camera.y + by[1] });
    } else if (event.key === "+" || event.key === "=") {
      setCamera(zoomed(camera, step, centre));
    } else if (event.key === "-") {
      setCamera(zoomed(camera, 1 / step, centre));
    } else if (event.key === "0") {
      fit();
    } else {
      return;
    }

    event.preventDefault();
  };

  const acting = async (run: () => Promise<unknown>): Promise<void> => {
    setProblem(undefined);

    try {
      await run();
      onChanged();
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  const placeSticky = async (
    sticky: Sticky,
    at: { x: number; y: number },
  ): Promise<void> => {
    setMoved({ id: sticky.id, ...at });

    await acting(async () =>
      api.put(`artifacts/${artifact.id}/stickies/${sticky.id}`, at),
    );
  };

  const nudgeSticky = (sticky: Sticky, at: { x: number; y: number }): void => {
    setMoved({ id: sticky.id, ...at });
    clearTimeout(nudging.current);

    nudging.current = setTimeout(() => {
      void acting(async () =>
        api.put(`artifacts/${artifact.id}/stickies/${sticky.id}`, at),
      );
    }, 400);
  };

  const chosen = [...stickies, ...lost].find((each) => each.id === selected);

  const remove = (sticky: Sticky): void => {
    setSelected(undefined);

    void acting(async () =>
      api.delete(`artifacts/${artifact.id}/stickies/${sticky.id}`),
    );
  };

  const where = (sticky: Sticky): { x: number; y: number } =>
    moved?.id === sticky.id ? moved : sticky;

  const pageCount = (id: string): number => boardsOn(canvas, id).length;
  const first = boards[0];
  const zoom = `${String(Math.round(camera.z * 100))}%`;

  const tool = (
    label: string,
    icon: IconName | undefined,
    run: () => void,
    pressed?: boolean,
  ): ReactElement => (
    <Button
      variant="ghost"
      size="sm"
      {...(pressed !== undefined && { "aria-pressed": pressed })}
      className={pressed === true ? "bg-hover text-fg-strong" : ""}
      onClick={run}
    >
      {icon !== undefined && <Icon name={icon} className="size-3.5" />}
      {label}
    </Button>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {canvas.pages.length > 1 && (
        <Tabs
          label="Pages"
          className="px-4"
          value={page}
          tabs={canvas.pages.map((each) => ({
            value: each.id,
            label: (
              <>
                {each.name}{" "}
                <span className="text-fg-dim">{pageCount(each.id)}</span>
              </>
            ),
          }))}
          onSelect={(next) => {
            setSelected(undefined);
            onSpot({ page: next, camera: undefined });
          }}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Boards"
          className="flex w-55 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3 text-label max-sm:hidden"
        >
          <span className="px-2 py-1 text-caption text-fg-dim">Boards</span>
          {boards.map((each) => (
            <button
              key={each.file}
              type="button"
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-fg hover:bg-hover"
              onClick={() => {
                onOpen(each.file, "board");
              }}
            >
              <span className="min-w-0 flex-1 truncate">{each.title}</span>
              {(counts.get(each.file) ?? 0) > 0 && (
                <Tag
                  pi
                  label={`${String(counts.get(each.file))} open ${counts.get(each.file) === 1 ? "comment" : "comments"}`}
                >
                  {counts.get(each.file)}
                </Tag>
              )}
              {view.changed.includes(each.file) && <Tag>changed</Tag>}
            </button>
          ))}
          {boards.length === 0 && (
            <span className="px-2 text-caption text-fg-dim">
              No boards on this page.
            </span>
          )}
          {lost.length > 0 && (
            <section
              aria-label="Stickies on a page that no longer exists"
              className="mt-3 flex flex-col gap-1.5"
            >
              <span className="px-2 py-1 text-caption text-fg-dim">
                On a page that no longer exists
              </span>
              {lost.map((each) => (
                <button
                  key={each.id}
                  type="button"
                  aria-current={each.id === selected ? "true" : undefined}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5 text-left text-caption text-on-sticky",
                    stickyClass[each.color],
                    each.id === selected && "ring-2 ring-accent",
                  )}
                  onClick={() => {
                    setSelected(each.id);
                  }}
                >
                  <b className="font-semibold">{each.author}: </b>
                  {each.text}
                </button>
              ))}
            </section>
          )}
        </nav>
        <div
          ref={(element) => {
            surface.current = element;
            measured(element);
          }}
          role="application"
          aria-roledescription="canvas"
          aria-label={`${canvas.pages.find(({ id }) => id === page)?.name ?? "Canvas"}. Arrow keys pan, plus and minus zoom, 0 fits.`}
          tabIndex={0}
          className="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-panel outline-none select-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-inset active:cursor-grabbing"
          style={{
            backgroundImage:
              "radial-gradient(var(--border-strong) 1px, transparent 1px)",
            backgroundSize: `${String(grid)}px ${String(grid)}px`,
            backgroundPosition: `${String(camera.x)}px ${String(camera.y)}px`,
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={keys}
          onClickCapture={(event) => {
            if (dragged.current) {
              event.preventDefault();
              event.stopPropagation();
              dragged.current = false;
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelected(undefined);
            }
          }}
        >
          <div
            className="absolute top-0 left-0"
            style={
              {
                transform: `translate(${String(camera.x)}px, ${String(camera.y)}px) scale(${String(camera.z)})`,
                transformOrigin: "0 0",
                "--ring": `${String(3 / camera.z)}px`,
              } as CSSProperties
            }
          >
            {notes.map((each) => (
              <Note key={each.id} note={each} />
            ))}
            {boards.map((each) => (
              <BoardTile
                key={each.file}
                artifact={artifact}
                version={version}
                board={each}
                zoom={camera.z}
                count={counts.get(each.file) ?? 0}
                changed={view.changed.includes(each.file)}
                onOpen={() => {
                  onOpen(each.file, "board");
                }}
                onFocus={() => {
                  reveal(each);
                }}
              />
            ))}
            {stickies.map((each) => (
              <PersonSticky
                key={each.id}
                sticky={each}
                at={where(each)}
                zoom={camera.z}
                selected={each.id === selected}
                onSelect={() => {
                  setSelected(each.id);
                }}
                onFocus={() => {
                  setSelected(each.id);
                  reveal({ ...where(each), w: stickyWidth, h: stickyHeight });
                }}
                onPlace={(at) => {
                  void placeSticky(each, at);
                }}
                onNudge={(at) => {
                  nudgeSticky(each, at);
                }}
              />
            ))}
          </div>
          {writing !== undefined && (
            <section
              data-tools
              aria-label="Comment on the whole canvas"
              className="pointer-events-none absolute inset-0 *:pointer-events-auto"
            >
              {writing(room)}
            </section>
          )}
          <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-wrap-reverse items-end justify-between gap-2 *:pointer-events-auto max-sm:inset-x-2 max-sm:bottom-2">
            <div
              data-tools
              role="toolbar"
              aria-label="Canvas"
              className="flex flex-wrap gap-1 rounded-[10px] border border-line bg-elevated p-1 shadow-xs"
            >
              {canComment &&
                tool(
                  "Move",
                  undefined,
                  () => {
                    onCommenting(false);
                  },
                  !commenting,
                )}
              {canComment &&
                tool(
                  "Comment",
                  "chat",
                  () => {
                    onCommenting(true);
                  },
                  commenting,
                )}
              {canComment &&
                tool("Sticky", "plus", () => {
                  setEditing("new");
                })}
              {first !== undefined &&
                tool("Play flow", "play", () => {
                  onOpen(first.file, "play");
                })}
              {chosen?.yours === true &&
                tool("Edit sticky", "pencil", () => {
                  setEditing(chosen);
                })}
              {chosen?.deletable === true &&
                tool("Delete sticky", "trash", () => {
                  remove(chosen);
                })}
            </div>
            <div
              data-tools
              role="toolbar"
              aria-label="Zoom"
              className="flex gap-1 rounded-[10px] border border-line bg-elevated p-1 shadow-xs"
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Zoom out"
                onClick={() => {
                  setCamera(zoomed(camera, 1 / step, centre));
                }}
              >
                −
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Zoom ${zoom}, set to 100%`}
                onClick={() => {
                  setCamera(zoomed(camera, 1 / camera.z, centre));
                }}
              >
                {zoom}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Zoom in"
                onClick={() => {
                  setCamera(zoomed(camera, step, centre));
                }}
              >
                <Icon name="plus" className="size-3.5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={fit}>
                Fit
              </Button>
            </div>
          </div>
          <span aria-live="polite" className="sr-only">
            Zoom {zoom}
          </span>
          {problem !== undefined && (
            <div className="absolute inset-x-4 top-4 rounded-md border border-line bg-elevated px-3 py-2 shadow-xs">
              <ErrorText size="caption">{problem}</ErrorText>
            </div>
          )}
        </div>
      </div>
      <StickyDialog
        sticky={editing}
        onClose={() => {
          setEditing(undefined);
        }}
        onSave={async ({ text, color }) => {
          if (editing === "new") {
            const at = {
              x: (centre.x - camera.x) / camera.z - stickyWidth / 2,
              y: (centre.y - camera.y) / camera.z - stickyHeight / 2,
            };

            const { id } = await api.post<{ id: string }>(
              `artifacts/${artifact.id}/stickies`,
              { page, ...at, text, color },
            );

            setSelected(id);
          } else if (editing !== undefined) {
            await api.put(`artifacts/${artifact.id}/stickies/${editing.id}`, {
              text,
              color,
            });
          }

          setEditing(undefined);
          onChanged();
        }}
      />
    </div>
  );
}

function Note({ note }: { readonly note: CanvasNote }): ReactElement {
  if (note.heading > 0) {
    return (
      <p
        role="heading"
        aria-level={note.heading + 2}
        className={cn(
          "absolute w-max leading-tight font-bold text-fg-strong",
          headingClass[note.heading],
        )}
        style={{ left: note.x, top: note.y, maxWidth: Math.max(note.w, 2000) }}
      >
        {note.text}
      </p>
    );
  }

  return (
    <p
      role="note"
      aria-label={`Note from Pi: ${note.text}`}
      className={cn(
        "absolute rounded-xl p-5 text-[24px] leading-normal whitespace-pre-line text-on-sticky shadow-xs",
        stickyClass[note.color],
      )}
      style={{ left: note.x, top: note.y, width: note.w }}
    >
      <b className="font-semibold">π Pi: </b>
      {note.text}
    </p>
  );
}

function PersonSticky({
  sticky,
  at,
  zoom,
  selected,
  onSelect,
  onFocus,
  onPlace,
  onNudge,
}: {
  readonly sticky: Sticky;
  readonly at: { readonly x: number; readonly y: number };
  readonly zoom: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onFocus: () => void;
  readonly onPlace: (at: { x: number; y: number }) => void;
  readonly onNudge: (at: { x: number; y: number }) => void;
}): ReactElement {
  const [held, setHeld] = useState<{
    from: { x: number; y: number };
    by: { x: number; y: number };
  }>();

  const shown =
    held === undefined ? at : { x: at.x + held.by.x, y: at.y + held.by.y };

  return (
    <button
      type="button"
      data-sticky
      {...(sticky.yours && { "data-mine": true })}
      aria-current={selected ? "true" : undefined}
      aria-label={`Sticky from ${sticky.author}: ${sticky.text}${sticky.yours ? ". Arrow keys move it." : ""}`}
      className={cn(
        "absolute rounded-xl p-5 text-left text-[24px] leading-normal whitespace-pre-line text-on-sticky shadow-xs outline-none focus-visible:outline-(length:--ring) focus-visible:outline-offset-(length:--ring) focus-visible:outline-focus focus-visible:outline-solid",
        stickyClass[sticky.color],
        sticky.yours ? "cursor-move touch-none" : "cursor-pointer",
      )}
      style={{
        left: shown.x,
        top: shown.y,
        width: stickyWidth,
        ...(selected && {
          outline: `${String(3 / zoom)}px solid var(--accent)`,
          outlineOffset: 4 / zoom,
        }),
      }}
      onPointerDown={(event) => {
        onSelect();

        if (!sticky.yours) {
          return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);

        setHeld({
          from: { x: event.clientX, y: event.clientY },
          by: { x: 0, y: 0 },
        });
      }}
      onPointerMove={(event) => {
        if (held !== undefined) {
          setHeld({
            ...held,
            by: {
              x: (event.clientX - held.from.x) / zoom,
              y: (event.clientY - held.from.y) / zoom,
            },
          });
        }
      }}
      onPointerUp={() => {
        if (held !== undefined && (held.by.x !== 0 || held.by.y !== 0)) {
          onPlace(shown);
        }

        setHeld(undefined);
      }}
      onFocus={onFocus}
      onKeyDown={(event) => {
        const by: Record<string, readonly [number, number]> = {
          ArrowLeft: [-10 / zoom, 0],
          ArrowRight: [10 / zoom, 0],
          ArrowUp: [0, -10 / zoom],
          ArrowDown: [0, 10 / zoom],
        };

        const moves = by[event.key];

        if (moves === undefined || !sticky.yours) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        onNudge({ x: at.x + moves[0], y: at.y + moves[1] });
      }}
    >
      <b className="font-semibold">{sticky.author}: </b>
      {sticky.text}
    </button>
  );
}

function BoardTile({
  artifact,
  version,
  board,
  zoom,
  count,
  changed,
  onOpen,
  onFocus,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly board: CanvasBoard;
  readonly zoom: number;
  readonly count: number;
  readonly changed: boolean;
  readonly onOpen: () => void;
  readonly onFocus: () => void;
}): ReactElement {
  const label = Math.min(12 / zoom, 60);

  return (
    <div
      className="absolute"
      style={{ left: board.x, top: board.y, width: board.w, height: board.h }}
    >
      {zoom >= 0.15 && (
        <span
          aria-hidden
          className="absolute bottom-full left-0 flex items-center gap-1.5 whitespace-nowrap text-fg-dim"
          style={{ fontSize: label, marginBottom: label / 2 }}
        >
          {board.title}
          {changed && (
            <span className="rounded-full bg-hover px-[0.5em] text-[0.9em]">
              changed in this version
            </span>
          )}
        </span>
      )}
      <iframe
        title={board.title}
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        sandbox={frameSandbox}
        src={boardSrc(artifact, version, board.file)}
        className="pointer-events-none size-full rounded-sm border-0 bg-canvas shadow-card"
      />
      <button
        type="button"
        aria-label={[
          `Open ${board.title}`,
          ...(changed ? ["changed in this version"] : []),
          ...(count > 0
            ? [`${String(count)} open ${count === 1 ? "comment" : "comments"}`]
            : []),
        ].join(", ")}
        className="absolute inset-0 cursor-pointer rounded-sm outline-none hover:ring-4 hover:ring-line-strong focus-visible:outline-(length:--ring) focus-visible:outline-offset-(length:--ring) focus-visible:outline-accent focus-visible:outline-solid"
        onClick={onOpen}
        onFocus={onFocus}
      />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute grid place-items-center rounded-[50%_50%_50%_8%] bg-butter font-semibold text-on-butter"
          style={{
            right: -12 / zoom,
            top: -12 / zoom,
            width: 24 / zoom,
            height: 24 / zoom,
            fontSize: 11 / zoom,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function StickyDialog({
  sticky,
  onClose,
  onSave,
}: {
  readonly sticky: Sticky | "new" | undefined;
  readonly onClose: () => void;
  readonly onSave: (said: {
    text: string;
    color: StickyColor;
  }) => Promise<void>;
}): ReactElement {
  return (
    <Dialog
      open={sticky !== undefined}
      onClose={onClose}
      size="sm"
      title={sticky === "new" ? "New sticky" : "Edit sticky"}
      description="Everyone who can see the canvas reads it, and Pi when it reads the canvas."
    >
      <StickyForm
        key={sticky === "new" ? "new" : (sticky?.id ?? "")}
        sticky={sticky === "new" ? undefined : sticky}
        onClose={onClose}
        onSave={onSave}
      />
    </Dialog>
  );
}

function StickyForm({
  sticky,
  onClose,
  onSave,
}: {
  readonly sticky: Sticky | undefined;
  readonly onClose: () => void;
  readonly onSave: (said: {
    text: string;
    color: StickyColor;
  }) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState(sticky?.text ?? "");
  const [color, setColor] = useState<StickyColor>(sticky?.color ?? "yellow");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(undefined);

        void onSave({ text: text.trim(), color })
          .catch((error: unknown) => {
            setProblem(errorText(error));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <DialogBody>
        <Field label="What it says">
          <TextArea
            value={text}
            rows={3}
            required
            autoFocus
            maxLength={2000}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
        <Segmented
          label="Colour"
          value={color}
          options={peopleColors.map((each) => ({
            value: each,
            label: colorNames[each],
          }))}
          onChange={setColor}
        />
        <ErrorText size="caption">{problem}</ErrorText>
      </DialogBody>
      <DialogFoot>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || text.trim() === ""}
        >
          {sticky === undefined ? "Add sticky" : "Save"}
        </Button>
      </DialogFoot>
    </form>
  );
}

export function BoardPane({
  canvas,
  board,
  mode,
  comparable,
  onMode,
  onBoard,
  onBack,
  stage,
  writing,
}: {
  readonly canvas: Canvas;
  readonly board: CanvasBoard;
  readonly mode: BoardMode;
  // Whether the version shown changed it, or may have.
  readonly comparable: boolean;
  readonly onMode: (mode: BoardMode | "compare") => void;
  readonly onBoard: (file: string) => void;
  readonly onBack: () => void;
  readonly stage: (style: CSSProperties) => ReactElement;
  readonly writing: (
    area: { readonly width: number; readonly height: number },
    scale: number,
  ) => ReactNode;
}): ReactElement {
  const boards = boardsOn(canvas, board.page);
  const at = boards.findIndex(({ file }) => file === board.file);
  const [measured, room] = useSize();
  const pad = room.width < 640 ? 12 : 24;

  const scale =
    room.width === 0
      ? 1
      : Math.min(
          1,
          (room.width - pad * 2) / board.w,
          mode === "play" ? (room.height - pad * 2) / board.h : Infinity,
        );

  const area = { width: board.w * scale, height: board.h * scale };

  const go = (by: number): void => {
    const next = boards[at + by];

    if (next !== undefined) {
      onBoard(next.file);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 max-sm:gap-1 max-sm:px-2 max-sm:py-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to the canvas"
          onClick={onBack}
        >
          <Icon name="chevron-left" className="size-3.5" />
          <span className="max-sm:hidden">Canvas</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-ui font-semibold text-fg-strong">
            {board.title}
          </h3>
          <span className="truncate text-caption text-fg-dim max-sm:hidden">
            {[
              ...(canvas.title === "" ? [] : [canvas.title]),
              `board ${String(at + 1)} of ${String(boards.length)}`,
            ].join(" · ")}
          </span>
        </div>
        <Segmented
          label="Board view"
          value={mode}
          options={[
            { value: "board", label: "Board" },
            { value: "play", label: "Play" },
            ...(comparable
              ? [{ value: "compare" as const, label: "Compare" }]
              : []),
          ]}
          onChange={onMode}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Previous board"
          disabled={at <= 0}
          onClick={() => {
            go(-1);
          }}
        >
          <Icon name="chevron-left" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Next board"
          disabled={at < 0 || at >= boards.length - 1}
          onClick={() => {
            go(1);
          }}
        >
          <Icon name="chevron-right" className="size-3.5" />
        </Button>
      </div>
      <div
        ref={measured}
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center overflow-auto",
          mode === "play" ? "justify-center bg-scrim" : "bg-panel",
        )}
        style={{ padding: pad }}
      >
        <div
          className="relative shrink-0 overflow-hidden rounded-md bg-canvas shadow-card"
          style={area}
        >
          {stage({
            position: "absolute",
            top: 0,
            left: 0,
            width: board.w,
            height: board.h,
            transform: `scale(${String(scale)})`,
            transformOrigin: "0 0",
          })}
          {writing(area, scale)}
        </div>
      </div>
    </div>
  );
}

interface Compared {
  readonly board: CanvasBoard;
  readonly older: boolean;
  readonly newer: boolean;
  readonly tag?: string;
}

export function ChangedBoards({
  artifact,
  view,
  board,
  from,
  to,
  sideName,
}: {
  readonly artifact: ArtifactView;
  // Undefined while it loads.
  readonly view: CanvasView | null | undefined;
  // Only this board, when Compare started from it.
  readonly board: string | undefined;
  readonly from: number;
  readonly to: number;
  readonly sideName: (version: number) => string;
}): ReactElement {
  if (view === undefined) {
    return <div aria-busy className="flex-1 bg-panel" />;
  }

  const boards = view?.canvas?.boards ?? [];
  const shared = view?.shared ?? [];
  const only = (file: string): boolean => board === undefined || file === board;

  const compared: readonly Compared[] = [
    ...boards
      .filter(({ file }) => view?.changed.includes(file) === true)
      .map((each) => ({ board: each, older: true, newer: true })),
    ...boards
      .filter(({ file }) => view?.added.includes(file) === true)
      .map((each) => ({
        board: each,
        older: false,
        newer: true,
        tag: "added",
      })),
    ...(view?.removed ?? []).map((each) => ({
      board: each,
      older: true,
      newer: false,
      tag: "removed",
    })),
    ...(shared.length === 0
      ? []
      : boards
          .filter(
            ({ file }) =>
              view?.changed.includes(file) !== true &&
              view?.added.includes(file) !== true,
          )
          .map((each) => ({
            board: each,
            older: true,
            newer: true,
            tag: "may have changed",
          }))),
  ].filter((each) => only(each.board.file));

  if (compared.length === 0) {
    return (
      <p className="flex flex-1 items-center justify-center bg-panel p-8 text-fg-dim">
        No board changed between these versions.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-panel p-5 max-sm:p-3">
      {shared.length > 0 && (
        <p role="note" className="text-label text-fg-dim">
          {shared.join(", ")} changed too, so boards that use{" "}
          {shared.length === 1 ? "it" : "them"} may look different.
        </p>
      )}
      {compared.map(({ board: each, older, newer, tag }) => (
        <section
          key={each.file}
          aria-label={each.title}
          className="flex flex-col gap-2"
        >
          <h3 className="flex items-center gap-2 text-ui font-semibold text-fg-strong">
            {each.title}
            {tag !== undefined && <Tag>{tag}</Tag>}
          </h3>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            {[
              { version: from, there: older },
              { version: to, there: newer },
            ].map(({ version, there }) => (
              <div key={version} className="flex min-w-0 flex-col gap-2">
                <span className="text-caption text-fg-dim">
                  {sideName(version)}
                </span>
                {there ? (
                  <ScaledBoard
                    artifact={artifact}
                    version={version}
                    board={each}
                  />
                ) : (
                  <div
                    className="grid w-full place-items-center rounded-md border border-dashed border-line-strong text-label text-fg-dim"
                    style={{
                      aspectRatio: `${String(each.w)} / ${String(each.h)}`,
                    }}
                  >
                    Not in version {version}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScaledBoard({
  artifact,
  version,
  board,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly board: CanvasBoard;
}): ReactElement {
  const [measured, size] = useSize();
  const scale = size.width === 0 ? 0 : size.width / board.w;

  return (
    <div
      ref={measured}
      className="relative w-full overflow-hidden rounded-md bg-canvas shadow-card"
      style={{ aspectRatio: `${String(board.w)} / ${String(board.h)}` }}
    >
      <iframe
        title={`${board.title}, version ${String(version)}`}
        loading="lazy"
        sandbox={frameSandbox}
        src={boardSrc(artifact, version, board.file)}
        className="border-0 bg-canvas"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: board.w,
          height: board.h,
          transform: `scale(${String(scale)})`,
          transformOrigin: "0 0",
        }}
      />
    </div>
  );
}
