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

// A file's media type, from its extension.
const mimes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mimeOf(name: string): string {
  return (
    mimes[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
    "application/octet-stream"
  );
}
