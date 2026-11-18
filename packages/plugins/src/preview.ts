import { marked } from "marked";
import { type PreviewKind, previewKind } from "./preview-kind";

const mimes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

interface PreviewOptions {
  readonly kind?: PreviewKind | undefined;
  readonly scriptHosts?: readonly string[];
  // Runs in every page but a picture or PDF.
  readonly script?: string;
}

// The page a viewer's frame shows for a file, or undefined for one it can't
// draw. Every one but a PDF runs on an opaque origin, so its scripts can't
// reach Pipoca's API or the viewer's sign-in, and it loads scripts and
// styles only from the hosts admins list (ADR 0078). Browsers don't show a
// PDF in a sandbox; a PDF runs no page scripts of its own. As text, any
// file it draws shows as its source.
export function preview(
  name: string,
  content: Uint8Array,
  options: PreviewOptions & { readonly kind: PreviewKind },
): Response;
export function preview(
  name: string,
  content: Uint8Array,
  options?: PreviewOptions,
): Response | undefined;
export function preview(
  name: string,
  content: Uint8Array,
  {
    kind = previewKind(name),
    scriptHosts = [],
    script = "",
  }: PreviewOptions = {},
): Response | undefined {
  if (kind === undefined) {
    return undefined;
  }

  const headers = new Headers({
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    "referrer-policy": "no-referrer",
  });

  if (kind !== "pdf") {
    headers.set("content-security-policy", policy(scriptHosts));
  }

  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";

  if (kind === "image" || kind === "svg" || kind === "pdf") {
    headers.set("content-type", mimes[ext] ?? "application/octet-stream");

    return new Response(new Uint8Array(content), { headers });
  }

  headers.set("content-type", "text/html; charset=utf-8");

  const text = new TextDecoder().decode(content);

  if (kind === "html") {
    return new Response(withScript(text, script), { headers });
  }

  const bodies = {
    markdown: () => markdown(text, scriptHosts),
    csv: () => table(parseCsv(text)),
    text: () => `<pre>${escaped(text)}</pre>`,
  };

  return new Response(page(name, bodies[kind](), script), { headers });
}

function policy(scriptHosts: readonly string[]): string {
  const hosts = scriptHosts.map((host) => `https://${host}`).join(" ");

  return [
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${hosts}`,
    `style-src 'unsafe-inline' ${hosts}`,
    `img-src data: blob: ${hosts}`,
    `font-src data: ${hosts}`,
    "media-src data: blob:",
    "form-action 'none'",
  ].join("; ");
}

// RFC 4180: fields in quotes may hold commas, newlines and doubled quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function table(rows: readonly (readonly string[])[]): string {
  const [head = [], ...rest] = rows;

  const cells = (row: readonly string[], tag: "th" | "td"): string =>
    `<tr>${row.map((cell) => `<${tag}>${escaped(cell)}</${tag}>`).join("")}</tr>`;

  return `<table class="sheet"><thead>${cells(head, "th")}</thead><tbody>${rest.map((row) => cells(row, "td")).join("")}</tbody></table>`;
}

function withScript(html: string, script: string): string {
  const end = html.lastIndexOf("</body>");

  return end < 0
    ? `${html}${script}`
    : `${html.slice(0, end)}${script}${html.slice(end)}`;
}

const mermaid = "cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

// A Markdown source as its page would draw it, for a frame that runs no
// scripts and loads nothing, while a person edits it.
export function previewed(name: string, text: string): string {
  return page(name, markdown(text, [])).replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8"><meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
  );
}

function markdown(text: string, scriptHosts: readonly string[]): string {
  const html = marked
    .parse(text, { async: false, gfm: true })
    .replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      '<pre class="mermaid">$1</pre>',
    );

  const drawsDiagrams =
    html.includes('class="mermaid"') &&
    scriptHosts.some((host) => `${mermaid}/`.startsWith(`${host}/`));

  return drawsDiagrams
    ? `${html}<script src="https://${mermaid}"></script><script>mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });</script>`
    : html;
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaped(title)}</title><style>
:root { color-scheme: light dark; --fg: #1a1712; --dim: #6b6457; --line: #e3ddd0; --bg: #fffdf8; --code: #f3efe5; --link: #2f5fb3; }
@media (prefers-color-scheme: dark) { :root { --fg: #ebe5d9; --dim: #a29a8c; --line: #322e27; --bg: #221f1a; --code: #1a1814; --link: #8fb3ff; } }
body { margin: 0 auto; max-width: 48rem; padding: 2rem 1rem; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--link); } img { max-width: 100%; }
pre, code { font-family: ui-monospace, monospace; font-size: 0.875em; background: var(--code); border-radius: 6px; }
code { padding: 0.15em 0.35em; } pre { padding: 1rem; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding-left: 1rem; color: var(--dim); border-left: 3px solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { padding: 0.35rem 0.75rem; border: 1px solid var(--line); text-align: left; } th { background: var(--code); }
body:has(> .sheet) { max-width: none; padding: 0; }
body:has(> pre:only-child) { max-width: none; padding: 0; } body > pre:only-child { margin: 0; min-height: 100vh; box-sizing: border-box; border-radius: 0; background: var(--bg); }
.sheet { display: table; min-width: 100%; font-size: 14px; } .sheet th, .sheet td { padding: 0.75rem 1rem; border: 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.sheet th { position: sticky; top: 0; font-size: 12px; font-weight: 400; color: var(--dim); background: var(--bg); }
</style></head><body>${body}${script}</body></html>`;
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
