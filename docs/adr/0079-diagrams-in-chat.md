# 0079: Diagrams in chat

- Status: accepted
- Date: 2026-11-08
- Amends: [ADR 0022](0022-plugin-model-v2.md#more-web-slots-added-in-order)

## Context

A diagram is often the quickest way for the agent to show how parts connect, how a flow runs or which states a thing moves through. Mermaid is the common text format for that: models write it well, and where it isn't drawn (Slack, email, Pi's terminal view) the text still reads.

Chat answers are Markdown drawn by `marked`, which shows raw HTML as text and turns links of other schemes into `link:<scheme>` slots a plugin fills ([ADR 0028](0028-projects-around-the-coordinator.md#new-web-slots)). A ` ```mermaid ` block shows as code.

ADR 0022 planned a `codeBlocks` slot for this and never built it. Mermaid is over 1 MB of script, and telling the agent when to draw costs prompt tokens on every turn, so not every server wants it.

## Decision

### The kernel draws fenced blocks through a slot

- A web part fills `codeBlock:<language>` to draw a fenced block in that language, with the block's text as `code`. It follows `link:<scheme>`: the first plugin that fills it draws, inside the plugin's error boundary.
- A fence the agent is still writing comes with `complete` false, so its plugin can get ready, such as by loading a library. A block no plugin fills shows as code.
- The kernel names no language and loads no renderer.

### A diagrams plugin draws Mermaid

- `diagrams` is a built-in plugin, on by default, that fills `codeBlock:mermaid`.
- It loads Mermaid the first time a diagram is drawn, so pages without one never fetch it. It starts loading while the agent is still writing the block, and shows that it is drawing once the block is done. The build splits and minifies the web bundle so this holds in the compiled binary too.
- It runs Mermaid with `securityLevel: "strict"`, which leaves out scripts, click handlers and HTML labels.
- It colours diagrams from the page's theme tokens and draws them again when the theme changes.
- A block Mermaid can't read shows as code, with Mermaid's error under it.
- Drawn diagrams are kept by text and theme, so a chat that redraws while an answer streams doesn't run Mermaid again.

### The agent is told when to draw

The plugin's Session part adds one rule to the system prompt: use a Mermaid block when a picture explains better than prose, such as a flow, a sequence, states or how parts connect, and keep it small. Turning the plugin off removes the rule and the drawing together.

## Consequences

- Any plugin can draw its own languages, such as `vega-lite` or `math`, without kernel changes.
- Mermaid artifacts ([ADR 0078](0078-artifacts-and-session-files.md)) still show as code. The artifacts plugin can use the same renderer later.
- Where chat isn't drawn by the web app, people see the Mermaid text.
