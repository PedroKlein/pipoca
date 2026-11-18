import { marked } from "marked";

// Every page but a picture or PDF tells the artifact page what the person
// selected or, in comment mode, clicked, to comment on it. It pins the
// threads on the text or element they're on, and when compared marks the
// words one version changed, by where they sit in the page's text. What it
// draws is marked data-pipoca-ui and stays out of the way of the page.
export const selection = `<script>(() => {
const rectOf = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const tell = () => {
  const picked = getSelection();
  const text = String(picked).trim();
  if (text === "" || picked.rangeCount === 0) return;
  parent.postMessage({ pipoca: "selection", text: text.slice(0, 2000), rect: rectOf(picked.getRangeAt(0).getBoundingClientRect()) }, "*");
};
document.addEventListener("mouseup", tell);
document.addEventListener("keyup", (event) => { if (event.shiftKey) tell(); });
const drawn = (look) => {
  const box = document.createElement("div");
  box.dataset.pipocaUi = "";
  box.setAttribute("style", "position: absolute; z-index: 2147483646; box-sizing: border-box; pointer-events: none; " + look);
  document.body.append(box);
  return box;
};
const around = (box, element) => {
  const r = element.getBoundingClientRect();
  Object.assign(box.style, { left: r.left + scrollX - 3 + "px", top: r.top + scrollY - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px", display: "block" });
};
const pickable = (element) => element instanceof Element && element !== document.body && element !== document.documentElement && element.closest("[data-pipoca-ui]") === null;
const selectorOf = (element) => {
  const path = [];
  for (let at = element; at !== null && at !== document.body; at = at.parentElement) {
    if (at.id !== "" && document.querySelectorAll("#" + CSS.escape(at.id)).length === 1) return ["#" + CSS.escape(at.id), ...path].join(" > ");
    const same = [...(at.parentElement?.children ?? [])].filter((each) => each.localName === at.localName);
    path.unshift(CSS.escape(at.localName) + ":nth-of-type(" + String(same.indexOf(at) + 1) + ")");
  }
  return ["body", ...path].join(" > ");
};
const labelOf = (element) => (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("alt") ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 80) || element.tagName.toLowerCase();
let commenting = false;
let hover;
document.addEventListener("mousemove", (event) => {
  if (!commenting || !pickable(event.target)) return;
  hover ??= drawn("border: 2px dashed rgb(232, 176, 74); border-radius: 4px;");
  around(hover, event.target);
});
document.addEventListener("keydown", (event) => {
  if (commenting && event.key === "Escape") parent.postMessage({ pipoca: "escape" }, "*");
});
document.documentElement.addEventListener("mouseleave", () => {
  if (hover !== undefined) hover.style.display = "none";
});
document.addEventListener("click", (event) => {
  if (!commenting || !pickable(event.target) || String(getSelection()).trim() !== "") return;
  event.preventDefault();
  event.stopPropagation();
  parent.postMessage({ pipoca: "element", selector: selectorOf(event.target), label: labelOf(event.target), rect: rectOf(event.target.getBoundingClientRect()) }, "*");
}, true);
let pins = [];
const pin = () => {
  for (const mark of document.querySelectorAll("mark[data-pipoca]")) mark.replaceWith(...mark.childNodes);
  for (const each of document.querySelectorAll("[data-pipoca-pin]")) each.remove();
  document.body.normalize();
  for (const { n, quote, selector, active } of pins) {
    let target = null;
    if (selector !== "") {
      try { target = document.querySelector(selector); } catch { target = null; }
    } else if (quote !== "") {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const start = node.data.indexOf(quote);
        if (start < 0 || node.parentElement?.closest("script, style, [data-pipoca-ui]") != null) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + quote.length);
        target = document.createElement("mark");
        target.dataset.pipoca = n === null ? "draft" : String(n);
        target.setAttribute("style", "color: inherit; border-radius: 2px; background: " + (n === null ? "rgba(84, 132, 230, 0.28)" : active ? "rgba(243, 197, 82, 0.6)" : "rgba(243, 197, 82, 0.35)") + ";");
        range.surroundContents(target);
        break;
      }
    }
    if (target === null) continue;
    if (selector !== "" && (active || n === null)) {
      const box = drawn("border: 2px solid " + (n === null ? "rgb(84, 132, 230)" : "rgb(243, 197, 82)") + "; border-radius: 3px;");
      box.dataset.pipocaPin = "";
      around(box, target);
    }
    if (active) target.scrollIntoView({ block: "nearest" });
    if (n === null) continue;
    const r = target.getBoundingClientRect();
    const badge = drawn("display: grid; place-items: center; width: 22px; height: 22px; border-radius: 11px 11px 11px 2px; background: rgb(243, 197, 82); color: rgb(26, 23, 18); font: 600 11px/1 system-ui, sans-serif; pointer-events: auto; cursor: pointer; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);");
    badge.dataset.pipocaPin = String(n);
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;
    badge.setAttribute("aria-label", "Comment " + String(n));
    badge.textContent = String(n);
    badge.style.left = (selector === "" ? r.right - 8 : r.left + 18) + scrollX + "px";
    badge.style.top = r.top + scrollY - 20 + "px";
    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ pipoca: "pin", n }, "*");
    };
    badge.addEventListener("click", open);
    badge.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(event); });
  }
};
addEventListener("resize", pin);
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (event.data?.pipoca === "commenting") {
    commenting = event.data.on === true;
    if (!commenting && hover !== undefined) hover.style.display = "none";
    document.documentElement.style.cursor = commenting ? "crosshair" : "";
  } else if (event.data?.pipoca === "pins") {
    pins = event.data.pins;
    pin();
  }
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
    // The page's scripts may have changed its text since the viewer read it.
    // Then only longer runs are found again, where a short word would land
    // on the wrong spot.
    const start = text.length === event.data.length && text.slice(change.start, change.end) === change.text ? change.start : change.text.length >= 12 ? text.indexOf(change.text, from) : -1;
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
