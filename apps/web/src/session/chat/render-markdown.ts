import { Marked, Renderer, type Tokens } from "marked";

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => escapes[char] ?? char);
}

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href, "https://relative.invalid/");

    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

const plain = new Renderer();

const closingFence = /\n {0,3}(?:`{3,}|~{3,})[ \t]*\n*$/;

// Answers quote tool output and repository files, so raw HTML in them is
// shown as text and only web links become links.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    link({ href, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const target = safeHref(href);

      if (target !== undefined) {
        return `<a href="${escape(target)}" target="_blank" rel="noreferrer">${label}</a>`;
      }

      const scheme = /^([a-z][a-z0-9-]*):(.+)$/.exec(href);

      // A plugin draws links of its own schemes in the chat (ADR 0028).
      return scheme
        ? `<span data-link="${escape(scheme[1] ?? "")}" data-target="${escape(scheme[2] ?? "")}">${label}</span>`
        : label;
    },
    image: ({ text }) => escape(text),
    // A plugin draws a fence of its language (ADR 0079).
    code(token: Tokens.Code) {
      const html = plain.code(token);
      const language = token.lang?.split(/\s/)[0] ?? "";

      if (!/^[\w-]+$/.test(language)) {
        return html;
      }

      const open = closingFence.test(token.raw) ? "" : ' data-code-open=""';

      return `<div data-code-block="${language}"${open}>${html.trimEnd()}</div>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}
