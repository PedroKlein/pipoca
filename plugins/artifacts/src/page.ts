import { marked } from "marked";

// Every page but a picture or PDF tells the artifact page what the person
// selected, to quote it in a comment, marks the text comments quote, and
// when compared marks the words one version changed, by where they sit in
// the page's text.
export const selection = `<script>(() => {
document.addEventListener("mouseup", () => { const text = String(getSelection()).trim(); if (text !== "") parent.postMessage({ pipoca: "selection", text: text.slice(0, 2000) }, "*"); });
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.pipoca !== "highlight") return;
  for (const mark of document.querySelectorAll("mark[data-pipoca]")) mark.replaceWith(...mark.childNodes);
  document.body.normalize();
  event.data.quotes.forEach((quote, at) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const start = node.data.indexOf(quote);
      if (start < 0 || node.parentElement?.closest("script, style") != null) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + quote.length);
      const mark = document.createElement("mark");
      mark.dataset.pipoca = String(at + 1);
      mark.title = "Comment " + String(at + 1);
      range.surroundContents(mark);
      break;
    }
  });
});
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.pipoca !== "changes") return;
  for (const mark of document.querySelectorAll("mark[data-pipoca-change]")) mark.replaceWith(...mark.childNodes);
  document.body.normalize();
  const nodes = [];
  let text = "";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest("script, style") != null) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  const look = event.data.kind === "removed" ? "background: rgba(255, 82, 82, 0.22); text-decoration: line-through;" : "background: rgba(46, 160, 67, 0.22);";
  const pieces = [];
  let from = 0;
  for (const change of event.data.spans) {
    let start = text.slice(change.start, change.end) === change.text ? change.start : text.indexOf(change.text, from);
    if (start < 0) continue;
    const end = start + change.text.length;
    from = end;
    for (const { node, start: at } of nodes) {
      const a = Math.max(start, at), b = Math.min(end, at + node.data.length);
      if (a < b) pieces.push({ node, a: a - at, b: b - at });
    }
  }
  for (const { node, a, b } of pieces.reverse()) {
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    const mark = document.createElement("mark");
    mark.dataset.pipocaChange = event.data.kind;
    mark.setAttribute("style", "color: inherit; border-radius: 2px; " + look);
    range.surroundContents(mark);
  }
});
})();</script>`;

const mermaid = "cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

// A Markdown source as its page would draw it, for a frame that runs no
// scripts and loads nothing, while a person edits it.
export function previewed(name: string, text: string): string {
  return page(name, markdown(text, [])).replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8"><meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
  );
}

export function markdown(text: string, scriptHosts: readonly string[]): string {
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

export function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaped(title)}</title><style>
:root { color-scheme: light dark; --fg: #1f2328; --dim: #59636e; --line: #d1d9e0; --bg: #ffffff; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --dim: #9198a1; --line: #3d444d; --bg: #0d1117; --code: #151b23; --link: #4493f8; } }
body { margin: 0 auto; max-width: 48rem; padding: 2rem 1rem; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--link); } img { max-width: 100%; }
pre, code { font-family: ui-monospace, monospace; font-size: 0.875em; background: var(--code); border-radius: 6px; }
code { padding: 0.15em 0.35em; } pre { padding: 1rem; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding-left: 1rem; color: var(--dim); border-left: 3px solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { padding: 0.35rem 0.75rem; border: 1px solid var(--line); text-align: left; } th { background: var(--code); }
</style></head><body>${body}${selection}</body></html>`;
}

export function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
