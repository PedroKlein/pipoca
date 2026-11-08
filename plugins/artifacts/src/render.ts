import { marked } from "marked";
import type { Kind } from "./artifacts";

const mimes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

const mermaid = "cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

// The document an artifact's frame shows. Every one but a PDF runs on an
// opaque origin, so its scripts can't reach Pipoca's API or the viewer's
// sign-in, and it loads scripts and styles only from the hosts admins list
// (ADR 0078). Browsers don't show a PDF in a sandbox; a PDF runs no page
// scripts of its own.
export function rendered(
  kind: Kind,
  name: string,
  content: Uint8Array,
  scriptHosts: readonly string[],
): Response {
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

    return new Response(content, { headers });
  }

  headers.set("content-type", "text/html; charset=utf-8");

  const text = new TextDecoder().decode(content);

  if (kind === "html") {
    return new Response(text, { headers });
  }

  const body =
    kind === "markdown" ? markdown(text, scriptHosts) : table(parseCsv(text));

  return new Response(page(name, body), { headers });
}

export function policy(scriptHosts: readonly string[]): string {
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

// RFC 4180: fields in quotes may hold commas, newlines and doubled quotes.
export function parseCsv(text: string): string[][] {
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

  return `<table><thead>${cells(head, "th")}</thead><tbody>${rest.map((row) => cells(row, "td")).join("")}</tbody></table>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaped(title)}</title><style>
:root { color-scheme: light dark; --fg: #1f2328; --dim: #59636e; --line: #d1d9e0; --bg: #ffffff; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --dim: #9198a1; --line: #3d444d; --bg: #0d1117; --code: #151b23; --link: #4493f8; } }
body { margin: 0 auto; max-width: 48rem; padding: 2rem 1rem; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--link); } img { max-width: 100%; }
pre, code { font-family: ui-monospace, monospace; font-size: 0.875em; background: var(--code); border-radius: 6px; }
code { padding: 0.15em 0.35em; } pre { padding: 1rem; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding-left: 1rem; color: var(--dim); border-left: 3px solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { padding: 0.35rem 0.75rem; border: 1px solid var(--line); text-align: left; } th { background: var(--code); }
</style></head><body>${body}</body></html>`;
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
