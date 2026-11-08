export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

// Past this many lines a side, comparing would take too long in a request.
const maxLines = 4000;

// The lines that changed from before to after, by longest common
// subsequence. Undefined when either side is too long to compare.
export function lineDiff(
  before: string,
  after: string,
): readonly DiffLine[] | undefined {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > maxLines || b.length > maxLines) {
    return undefined;
  }

  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              common[(i + 1) * width + j] ?? 0,
              common[i * width + j + 1] ?? 0,
            );
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length ||
        (common[i * width + j + 1] ?? 0) >= (common[(i + 1) * width + j] ?? 0))
    ) {
      lines.push({ kind: "added", text: b[j] ?? "" });
      j++;
    } else {
      lines.push({ kind: "removed", text: a[i] ?? "" });
      i++;
    }
  }

  return lines;
}
