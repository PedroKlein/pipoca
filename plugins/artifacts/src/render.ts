import type { Kind } from "./artifacts";
import { escaped, markdown, page, selection } from "./page";

const mimes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

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
    return new Response(withSelection(text), { headers });
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

function withSelection(html: string): string {
  const end = html.lastIndexOf("</body>");

  return end < 0
    ? `${html}${selection}`
    : `${html.slice(0, end)}${selection}${html.slice(end)}`;
}
