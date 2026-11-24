// Every page but a picture or PDF tells the artifact page what the person
// selected or, in comment mode, clicked, to comment on it. It pins the
// threads on the text or element they're on, tells its headings and which
// threads sit under each for a design doc's outline, and when compared marks the
// words one version changed, by where they sit in the page's text. On a
// decision record it writes a line under headings, such as who voted for an
// option. What it draws is marked data-pipoca-ui and stays out of the way of
// the page.
const selectorOf = `const selectorOf = (element) => {
  const path = [];
  for (let at = element; at !== null && at !== document.body; at = at.parentElement) {
    if (at.id !== "" && document.querySelectorAll("#" + CSS.escape(at.id)).length === 1) return ["#" + CSS.escape(at.id), ...path].join(" > ");
    const same = [...(at.parentElement?.children ?? [])].filter((each) => each.localName === at.localName);
    path.unshift(CSS.escape(at.localName) + ":nth-of-type(" + String(same.indexOf(at) + 1) + ")");
  }
  return ["body", ...path].join(" > ");
};`;

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
${selectorOf}
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
let badges = true;
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
    if (target === null || target.getClientRects().length === 0) continue;
    if (selector !== "" && (active || n === null)) {
      const box = drawn("border: 2px solid " + (n === null ? "rgb(84, 132, 230)" : "rgb(243, 197, 82)") + "; border-radius: 3px;");
      box.dataset.pipocaPin = "";
      around(box, target);
    }
    if (active && n !== shown) target.scrollIntoView({ block: "nearest" });
    if (n === null) continue;
    placed.push({ n, target });
    if (!badges) continue;
    const r = target.getBoundingClientRect();
    const badge = drawn("display: grid; place-items: center; width: 22px; height: 22px; border-radius: 11px 11px 11px 2px; background: rgb(243, 197, 82); color: rgb(26, 23, 18); font: 600 11px/1 system-ui, sans-serif; pointer-events: auto; cursor: pointer; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);");
    badge.dataset.pipocaPin = String(n);
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;
    badge.setAttribute("aria-label", "Comment " + String(n));
    badge.textContent = String(n);
    badge.style.left = Math.min(innerWidth - 26, Math.max(4, selector === "" || document.documentElement.hasAttribute("data-pipoca-deck") ? r.right - 4 : r.left + 18)) + scrollX + "px";
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
let lines = [];
const voted = "light-dark(rgb(23, 120, 75), rgb(110, 214, 160))";
const underline = () => {
  for (const each of document.querySelectorAll("pipoca-line")) each.remove();
  const all = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((each) => each.closest("[data-pipoca-ui]") === null);
  for (const { heading, text, strong, badge } of lines) {
    const at = all.find((each) => (each.textContent ?? "").trim().replace(/\\s+/g, " ").toLowerCase() === String(heading).toLowerCase());
    if (at === undefined) continue;
    const line = document.createElement("pipoca-line");
    line.dataset.pipocaUi = "";
    line.setAttribute("style", "display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -0.4em 0 0.6em; font: 600 12px/1.6 system-ui, sans-serif; color: " + (strong === true ? voted : "light-dark(rgb(107, 100, 87), rgb(162, 154, 140))") + ";");
    line.textContent = String(text);
    if (typeof badge === "string") {
      const mark = document.createElement("span");
      mark.textContent = badge;
      mark.setAttribute("style", "padding: 0 8px; border-radius: 999px; color: " + voted + "; background: light-dark(rgba(23, 120, 75, 0.12), rgba(110, 214, 160, 0.16));");
      line.append(mark);
    }
    at.after(line);
  }
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
    badges = event.data.badges !== false;
    pinAndShow();
  } else if (event.data?.pipoca === "lines" && Array.isArray(event.data.lines)) {
    lines = event.data.lines;
    underline();
    pin();
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

export const deck = `<script>(() => {
${selectorOf}
const look = document.createElement("style");
look.dataset.pipocaUi = "";
look.textContent = \`@media screen {
html[data-pipoca-deck], html[data-pipoca-deck] body { overflow: hidden !important; }
[data-pipoca-slide]:not([data-current]) { display: none !important; }
[data-pipoca-slide][data-current] { position: fixed !important; inset: 0 !important; z-index: 0 !important; box-sizing: border-box !important; width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; border-radius: 0 !important; box-shadow: none !important; overflow: hidden !important; }
[data-pipoca-notes] { display: none; }
}
[data-pipoca-slide] aside.notes { display: none !important; }
[data-pipoca-slide] [data-step]:not([data-shown]) { visibility: hidden; }
@media print {
html[data-pipoca-deck] body { display: block !important; margin: 0 !important; padding: 0 !important; background: none !important; }
[data-pipoca-slide] { position: relative !important; inset: auto !important; box-sizing: border-box !important; width: 1280px !important; height: 720px !important; max-width: none !important; max-height: none !important; margin: 0 !important; border-radius: 0 !important; box-shadow: none !important; overflow: hidden !important; break-inside: avoid; break-after: page; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
[data-pipoca-slide] [data-step] { visibility: visible !important; }
[data-pipoca-ui] { display: none !important; }
[data-pipoca-notes] { display: block; box-sizing: border-box; width: 1280px; height: 380px; padding: 40px 72px; overflow: hidden; break-after: page; background: #ffffff; color: #1a1712; font: 22px/1.5 system-ui, sans-serif; white-space: pre-line; }
}\`;
document.head.append(look);
document.documentElement.dataset.pipocaDeck = "";
const slides = () => {
  const all = [...document.querySelectorAll("section")].filter((each) => each.parentElement?.closest("section") == null && each.closest("[data-pipoca-ui]") === null);
  for (const each of all) each.dataset.pipocaSlide = "";
  return all;
};
const textOf = (element) => (element?.textContent ?? "").trim().replace(/\\s+/g, " ");
const notesOf = (section) => (section.querySelector("aside.notes")?.textContent ?? "").trim().replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n\\s*/g, "\\n\\n").replace(/\\n /g, "\\n");
const stepsOf = (section) => [...section.querySelectorAll("[data-step]")].map((element, at) => ({ element, at, order: Number(element.dataset.step) || 0 })).sort((a, b) => a.order - b.order || a.at - b.at).map(({ element }) => element);
const titleOf = (section) => {
  const heading = textOf(section.querySelector("h1, h2, h3, h4"));
  if (heading !== "") return heading.slice(0, 80);
  const copy = section.cloneNode(true);
  copy.querySelector("aside.notes")?.remove();
  const words = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const said = [];
  while (words.nextNode()) said.push(words.currentNode.data);
  return said.join(" ").trim().replace(/\\s+/g, " ").slice(0, 80);
};
const durationOf = () => (document.querySelector("meta[name=duration]")?.getAttribute("content") ?? document.body.dataset.duration ?? "").trim().slice(0, 20);
const report = () => parent.postMessage({ pipoca: "deck", duration: durationOf(), slides: slides().map((section) => ({ selector: selectorOf(section), title: titleOf(section), notes: notesOf(section).slice(0, 5000), steps: stepsOf(section).length })) }, "*");
const whole = /^#slide=(\\d+)$/.exec(location.hash);
let at = { slide: whole === null ? 0 : Number(whole[1]), step: whole === null ? 0 : Infinity };
const show = () => {
  const all = slides();
  const slide = Math.max(0, Math.min(at.slide, all.length - 1));
  all.forEach((section, n) => section.toggleAttribute("data-current", n === slide));
  const current = all[slide];
  if (current === undefined) return;
  stepsOf(current).forEach((element, n) => element.toggleAttribute("data-shown", n < at.step));
  current.dispatchEvent(new CustomEvent("slide", { bubbles: true, detail: { slide, step: Math.min(at.step, stepsOf(current).length) } }));
  dispatchEvent(new Event("resize"));
};
show();
report();
addEventListener("load", () => { show(); report(); });
let commenting = false;
const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "b", "B", "Escape"];
document.addEventListener("keydown", (event) => {
  if (commenting || !keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.("input, textarea, select, [contenteditable]") != null) return;
  event.preventDefault();
  parent.postMessage({ pipoca: "key", key: event.key }, "*");
});
document.addEventListener("click", (event) => {
  if (commenting || event.defaultPrevented || event.target.closest?.("a, button, input, select, textarea, label, summary, video, audio, [onclick], [data-pipoca-ui]") != null || String(getSelection()).trim() !== "") return;
  parent.postMessage({ pipoca: "key", key: "click" }, "*");
});
const pinned = (pins) => {
  const all = slides();
  parent.postMessage({ pipoca: "pinned", pins: pins.flatMap(({ n, quote, selector }) => {
    if (typeof n !== "number") return [];
    let target = null;
    try { target = selector === "" ? null : document.querySelector(selector); } catch { target = null; }
    const slide = target === null ? all.findIndex((each) => quote !== "" && (each.textContent ?? "").includes(quote)) : all.findIndex((each) => each.contains(target));
    return slide < 0 ? [] : [{ n, slide }];
  }) }, "*");
};
const printed = (notes) => {
  const page = document.createElement("style");
  page.dataset.pipocaUi = "";
  page.textContent = notes ? "@page { size: 1280px 1100px; margin: 0; } @media print { [data-pipoca-slide] { break-after: auto !important; } }" : "@page { size: 1280px 720px; margin: 0; }";
  document.head.append(page);
  const added = notes ? slides().map((section) => {
    const box = document.createElement("div");
    box.dataset.pipocaNotes = "";
    box.textContent = notesOf(section);
    section.after(box);
    return box;
  }) : [];
  addEventListener("afterprint", () => {
    page.remove();
    for (const box of added) box.remove();
    parent.postMessage({ pipoca: "printed" }, "*");
  }, { once: true });
  print();
};
const rasterizer = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js";
const pictured = () => {
  const done = (said) => parent.postMessage({ pipoca: "png", ...said }, "*");
  const draw = () => {
    const current = slides().find((each) => each.hasAttribute("data-current"));
    globalThis.htmlToImage.toPng(current ?? document.body, { width: 1280, height: 720, canvasWidth: 1280, canvasHeight: 720, pixelRatio: 1 }).then((url) => done({ url }), () => done({ error: "The slide couldn't be drawn as a picture." }));
  };
  if (globalThis.htmlToImage !== undefined) return draw();
  const script = document.createElement("script");
  script.dataset.pipocaUi = "";
  script.src = rasterizer;
  script.onload = draw;
  script.onerror = () => done({ error: "Pictures of slides need cdn.jsdelivr.net/npm among the hosts pages may load scripts from." });
  document.head.append(script);
};
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const data = event.data;
  if (data?.pipoca === "commenting") commenting = data.on === true;
  else if (data?.pipoca === "slide" && Number.isInteger(data.slide) && Number.isInteger(data.step)) {
    at = { slide: data.slide, step: data.step };
    show();
  } else if (data?.pipoca === "pins" && Array.isArray(data.pins)) pinned(data.pins);
  else if (data?.pipoca === "print") printed(data.notes === true);
  else if (data?.pipoca === "png") pictured();
});
})();</script>`;
