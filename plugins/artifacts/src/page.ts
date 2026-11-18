// Every page but a picture or PDF tells the artifact page what the person
// selected or, in comment mode, clicked, to comment on it. It pins the
// threads on the text or element they're on, tells its headings and which
// threads sit under each for a design doc's outline, and when compared marks the
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
document.addEventListener("keyup", (event) => { if (event.key === "Shift") tell(); });
const drawn = (look) => {
  const box = document.createElement("div");
  box.dataset.pipocaUi = "";
  box.setAttribute("style", "position: absolute; z-index: 2147483646; box-sizing: border-box; pointer-events: none; user-select: none; " + look);
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
const pick = (element) => parent.postMessage({ pipoca: "element", selector: selectorOf(element), label: labelOf(element), rect: rectOf(element.getBoundingClientRect()) }, "*");
const labelOf = (element) => (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("alt") ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 80) || element.tagName.toLowerCase();
let commenting = false;
let hover;
document.addEventListener("mousemove", (event) => {
  if (!commenting || !pickable(event.target)) return;
  hover ??= drawn("border: 2px dashed rgb(232, 176, 74); border-radius: 4px;");
  around(hover, event.target);
});
document.addEventListener("keydown", (event) => {
  if (!commenting) return;
  if (event.key === "Escape") parent.postMessage({ pipoca: "escape" }, "*");
  if (event.key !== "Enter" || !pickable(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  pick(event.target);
}, true);
let scrolled = { x: scrollX, y: scrollY };
addEventListener("scroll", () => {
  parent.postMessage({ pipoca: "scroll", x: scrollX - scrolled.x, y: scrollY - scrolled.y }, "*");
  scrolled = { x: scrollX, y: scrollY };
});
document.documentElement.addEventListener("mouseleave", () => {
  if (hover !== undefined) hover.style.display = "none";
});
document.addEventListener("click", (event) => {
  if (!commenting || !pickable(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  if (String(getSelection()).trim() === "") pick(event.target);
}, true);
let pins = [];
let shown = null;
const pin = () => {
  for (const mark of document.querySelectorAll("mark[data-pipoca]")) mark.replaceWith(...mark.childNodes);
  for (const each of document.querySelectorAll("[data-pipoca-pin]")) each.remove();
  document.body.normalize();
  const placed = [];
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
    if (active && n !== shown) target.scrollIntoView({ block: "nearest" });
    if (n === null) continue;
    placed.push({ n, target });
    const r = target.getBoundingClientRect();
    const badge = drawn("display: grid; place-items: center; width: 22px; height: 22px; border-radius: 11px 11px 11px 2px; background: rgb(243, 197, 82); color: rgb(26, 23, 18); font: 600 11px/1 system-ui, sans-serif; pointer-events: auto; cursor: pointer; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);");
    badge.dataset.pipocaPin = String(n);
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;
    badge.setAttribute("aria-label", "Comment " + String(n));
    badge.textContent = String(n);
    badge.style.left = Math.min(innerWidth - 26, Math.max(4, selector === "" ? r.right - 4 : r.left + 18)) + scrollX + "px";
    badge.style.top = Math.max(2, r.top - 24) + scrollY + "px";
    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ pipoca: "pin", n }, "*");
    };
    badge.addEventListener("click", open);
    badge.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(event); });
  }
  outline(placed);
};
const headings = () => [...document.querySelectorAll("h1, h2, h3, h4")].filter((each) => each.closest("[data-pipoca-ui]") === null);
const outline = (placed) => {
  const all = headings();
  const sections = all.map((each) => ({ text: (each.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 80), level: Number(each.localName.slice(1)), threads: [] }));
  for (const { n, target } of placed) {
    const under = all.findLastIndex((each) => each === target || (each.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (under >= 0) sections[under].threads.push(n);
  }
  parent.postMessage({ pipoca: "outline", sections, tops: placed.map(({ n, target }) => ({ n, top: target.getBoundingClientRect().top + scrollY })), scrolled: scrollY }, "*");
};
const pinAndShow = () => {
  pin();
  shown = pins.find((each) => each.active)?.n ?? null;
};
addEventListener("resize", pin);
addEventListener("load", pin);
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (event.data?.pipoca === "commenting") {
    commenting = event.data.on === true;
    if (!commenting && hover !== undefined) hover.style.display = "none";
    document.documentElement.style.cursor = commenting ? "crosshair" : "";
  } else if (event.data?.pipoca === "pins") {
    pins = event.data.pins;
    pinAndShow();
  } else if (event.data?.pipoca === "goto") {
    headings()[event.data.section]?.scrollIntoView({ block: "start", behavior: "smooth" });
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
    if (node.parentElement?.closest("script, style, [data-pipoca-ui]") != null) continue;
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
