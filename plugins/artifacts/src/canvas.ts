export const stickyColors = ["yellow", "pink", "green", "blue"] as const;

export const peopleColors = ["yellow", "pink", "green"] as const;

export type StickyColor = (typeof stickyColors)[number];

export interface CanvasPage {
  readonly id: string;
  readonly name: string;
}

export interface CanvasBoard {
  readonly file: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly page: string;
}

export interface CanvasNote {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly text: string;
  readonly page: string;
  readonly heading: number;
  readonly color: StickyColor;
}

export interface Canvas {
  readonly title: string;
  readonly launch: string;
  readonly pages: readonly CanvasPage[];
  readonly boards: readonly CanvasBoard[];
  readonly notes: readonly CanvasNote[];
  readonly problems: readonly string[];
}

export interface Sticky {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly page: string;
  readonly color: StickyColor;
  readonly author: string;
  readonly yours: boolean;
  readonly deletable: boolean;
  readonly createdAt: number;
}

export interface CanvasView {
  readonly canvas: Canvas | null;
  readonly error: string | null;
  readonly stickies: readonly Sticky[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly CanvasBoard[];
  readonly shared: readonly string[];
  readonly against: number | null;
}

export const boardWidth = 1280;
export const boardHeight = 800;
export const stickyWidth = 360;

const maxBoards = 200;
const maxOrder = 1000;
const maxNotes = 500;
const maxPages = 100;
const maxText = 2000;
const maxName = 200;

type Field =
  | "title"
  | "pages"
  | "boards"
  | "order"
  | "notes"
  | "stickies"
  | "id"
  | "name"
  | "file"
  | "x"
  | "y"
  | "w"
  | "h"
  | "maxW"
  | "page"
  | "text"
  | "kind"
  | "color"
  | "launch";

type Fields = Readonly<Partial<Record<Field, unknown>>>;

const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const textOr = (value: unknown, fallback: string, most = maxName): string =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, most)
    : fallback;

const board = (path: string): boolean => /\.html?$/i.test(path);

export function canvasOf(
  text: string,
  paths: readonly string[],
): { readonly canvas: Canvas } | { readonly error: string } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      error: `canvas.json isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const top = fieldsOf(parsed);

  if (top === undefined) {
    return { error: "canvas.json must hold an object with its boards." };
  }

  const problems: string[] = [];

  const pageOf = (value: unknown): string => {
    const page = textOr(value, "");

    return /\p{Cc}/u.test(page) ? "" : page;
  };

  const pages = (Array.isArray(top.pages) ? top.pages.slice(0, maxPages) : [])
    .flatMap((each: unknown) => {
      const page = fieldsOf(each);
      const id = pageOf(page?.id);

      return id === "" ? [] : [{ id, name: textOr(page?.name, id) }];
    })
    .filter(
      (page, at, all) => all.findIndex(({ id }) => id === page.id) === at,
    );

  const listed: { readonly file: string; readonly fields: Fields }[] =
    Array.isArray(top.boards)
      ? top.boards.slice(0, maxBoards).flatMap((each: unknown) => {
          const fields = fieldsOf(each);
          const file = textOr(fields?.file, "", 1024);

          return fields === undefined || file === "" ? [] : [{ file, fields }];
        })
      : Object.entries(fieldsOf(top.boards) ?? {})
          .slice(0, maxBoards)
          .flatMap(([file, each]) => {
            const fields = fieldsOf(each);

            return fields === undefined ? [] : [{ file, fields }];
          });

  const rank = new Map<string, number>();

  for (const each of Array.isArray(top.order)
    ? top.order.slice(0, maxOrder)
    : []) {
    if (typeof each === "string" && !rank.has(each)) {
      rank.set(each, rank.size);
    }
  }

  const ranked = (file: string): number => rank.get(file) ?? rank.size;
  const files = new Set(paths);
  const placed = new Set<string>();
  const boards: CanvasBoard[] = [];

  for (const { file, fields } of [...listed].sort(
    (a, b) => ranked(a.file) - ranked(b.file),
  )) {
    if (!files.has(file)) {
      problems.push(
        `canvas.json lists the board ${file}, which isn't in the folder.`,
      );

      continue;
    }

    if (!board(file)) {
      problems.push(`The board ${file} isn't an HTML file.`);

      continue;
    }

    if (placed.has(file)) {
      continue;
    }

    placed.add(file);

    boards.push({
      file,
      x: numberOr(fields.x, 0),
      y: numberOr(fields.y, 0),
      w: Math.max(1, numberOr(fields.w, boardWidth)),
      h: Math.max(1, numberOr(fields.h, boardHeight)),
      title: textOr(fields.title, file),
      page: pageOf(fields.page),
    });
  }

  const notesIn: { readonly id: string; readonly fields: Fields }[] = [
    ...Object.entries(fieldsOf(top.notes) ?? {})
      .slice(0, maxNotes)
      .flatMap(([id, each]) => {
        const fields = fieldsOf(each);

        return fields === undefined ? [] : [{ id, fields }];
      }),
    ...(Array.isArray(top.stickies)
      ? top.stickies.slice(0, maxNotes)
      : []
    ).flatMap((each: unknown, at) => {
      const fields = fieldsOf(each);

      return fields === undefined
        ? []
        : [{ id: textOr(fields.id, `sticky-${String(at + 1)}`), fields }];
    }),
  ];

  const notes = notesIn.slice(0, maxNotes).flatMap(({ id, fields }) => {
    const said = textOr(fields.text, "", maxText);

    if (said === "") {
      return [];
    }

    const color = stickyColors.find((each) => each === fields.color) ?? "blue";
    const kind = typeof fields.kind === "string" ? fields.kind : "";

    return [
      {
        id,
        x: numberOr(fields.x, 0),
        y: numberOr(fields.y, 0),
        w: Math.max(40, numberOr(fields.w ?? fields.maxW, stickyWidth)),
        text: said,
        page: pageOf(fields.page),
        heading: kind.startsWith("title")
          ? Math.min(3, Math.max(1, Number(kind.slice(5)) || 1))
          : 0,
        color,
      },
    ];
  });

  const known = new Set(pages.map(({ id }) => id));

  const named = [
    ...pages,
    ...[...new Set([...boards, ...notes].map(({ page }) => page))]
      .filter((page) => page !== "" && !known.has(page))
      .slice(0, maxPages)
      .map((page) => ({ id: page, name: page })),
  ];

  const all = named.length === 0 ? [{ id: "main", name: "Canvas" }] : named;
  const first = all[0]?.id ?? "main";

  if (boards.length === 0) {
    problems.push("canvas.json lists no boards that are in the folder.");
  }

  return {
    canvas: {
      title: textOr(top.title, ""),
      launch:
        all.find(({ id }) => id === fieldsOf(top.launch)?.page)?.id ?? first,
      pages: all,
      boards: boards.map((each) =>
        each.page === "" ? { ...each, page: first } : each,
      ),
      notes: notes.map((each) =>
        each.page === "" ? { ...each, page: first } : each,
      ),
      problems,
    },
  };
}
