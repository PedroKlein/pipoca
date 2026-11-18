export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

// Past this many lines a side, comparing would take too long in a request.
const maxLines = 4000;

type Step = "same" | "added" | "removed";

// The steps from before to after, by longest common subsequence after the
// shared start and end. Undefined when the rest is too long to compare.
function steps(
  a: readonly string[],
  b: readonly string[],
): readonly Step[] | undefined {
  let head = 0;

  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }

  let tail = 0;

  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);

  if (x.length > maxLines || y.length > maxLines) {
    return undefined;
  }

  const width = y.length + 1;
  const common = new Uint32Array((x.length + 1) * width);

  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      common[i * width + j] =
        x[i] === y[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              common[(i + 1) * width + j] ?? 0,
              common[i * width + j + 1] ?? 0,
            );
    }
  }

  const middle: Step[] = [];
  let i = 0;
  let j = 0;

  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      middle.push("same");
      i++;
      j++;
    } else if (
      i < x.length &&
      (j === y.length ||
        (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      middle.push("removed");
      i++;
    } else {
      middle.push("added");
      j++;
    }
  }

  return [
    ...Array<Step>(head).fill("same"),
    ...middle,
    ...Array<Step>(tail).fill("same"),
  ];
}

// The lines that changed from before to after. Undefined when either side
// is too long to compare.
export function lineDiff(
  before: string,
  after: string,
): readonly DiffLine[] | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  const found = steps(a, b);

  if (found === undefined) {
    return undefined;
  }

  let i = 0;
  let j = 0;

  return found.map((kind): DiffLine => {
    if (kind === "same") {
      j++;

      return { kind, text: a[i++] ?? "" };
    }

    return kind === "added"
      ? { kind, text: b[j++] ?? "" }
      : { kind, text: a[i++] ?? "" };
  });
}

// Where some text sits in a longer one, from start up to end.
export interface Span {
  readonly start: number;
  readonly end: number;
}

interface Word extends Span {
  readonly text: string;
}

// Words never run across pieces, such as the text of two elements.
function words(pieces: readonly string[]): Word[] {
  let at = 0;

  return pieces.flatMap((piece) => {
    const found = [...piece.matchAll(/\S+/g)].map((match) => ({
      text: match[0],
      start: at + match.index,
      end: at + match.index + match[0].length,
    }));

    at += piece.length;

    return found;
  });
}

// The runs of words only before has, and only after has, by where they sit
// in each text the pieces make. Undefined when the texts are too long to
// compare.
export function textChanges(
  before: readonly string[],
  after: readonly string[],
): { readonly removed: Span[]; readonly added: Span[] } | undefined {
  const a = words(before);
  const b = words(after);

  const found = steps(
    a.map(({ text }) => text),
    b.map(({ text }) => text),
  );

  if (found === undefined) {
    return undefined;
  }

  const removed: Span[] = [];
  const added: Span[] = [];

  const extend = (runs: Span[], word: Word, continues: boolean): void => {
    const open = runs.at(-1);

    if (continues && open !== undefined) {
      runs[runs.length - 1] = { start: open.start, end: word.end };
    } else {
      runs.push({ start: word.start, end: word.end });
    }
  };

  let i = 0;
  let j = 0;
  let removing = false;
  let adding = false;

  for (const kind of found) {
    if (kind === "same") {
      i++;
      j++;
      removing = false;
      adding = false;
    } else if (kind === "removed") {
      const word = a[i++];

      if (word !== undefined) {
        extend(removed, word, removing);
      }

      removing = true;
    } else {
      const word = b[j++];

      if (word !== undefined) {
        extend(added, word, adding);
      }

      adding = true;
    }
  }

  return { removed, added };
}
