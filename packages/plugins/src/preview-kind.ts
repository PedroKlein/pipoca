// What a file is drawn as, from its extension. Text files show as their
// source.
export type PreviewKind =
  "html" | "markdown" | "svg" | "image" | "pdf" | "csv" | "text";

const kinds: Readonly<Record<string, PreviewKind>> = {
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  csv: "csv",
  ...Object.fromEntries(
    [
      "txt",
      "log",
      "json",
      "jsonl",
      "yaml",
      "yml",
      "toml",
      "ini",
      "xml",
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "css",
      "scss",
      "py",
      "go",
      "rs",
      "java",
      "kt",
      "rb",
      "php",
      "c",
      "h",
      "cpp",
      "cs",
      "swift",
      "sh",
      "bash",
      "sql",
      "tf",
      "diff",
      "patch",
      "tsv",
    ].map((ext) => [ext, "text" as const]),
  ),
};

export function previewKind(name: string): PreviewKind | undefined {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";

  return name.includes(".") ? kinds[ext] : undefined;
}

// The biggest file a viewer draws; a bigger one downloads.
export const previewBytes = 5_000_000;
