# 0085: Artifact types, templates, slides and design canvases

- Status: accepted
- Date: 2026-11-23
- Amends: [ADR 0078](0078-artifacts-and-session-files.md), [ADR 0081](0081-artifact-viewer-and-discussion.md), [ADR 0082](0082-living-markdown-artifacts.md)

## Context

An artifact is one file today: an HTML page, a Markdown doc, an SVG, a picture, a PDF or a CSV. The viewer draws it by its extension. A page that wants a stylesheet, a picture or some data must carry them inline.

People ask Pi for the same few shapes again and again: a deck for a review, a design doc, a decision with options, a set of mockups. Pi writes each one from nothing, so every deck looks different, and the team's way of writing a decision lives only in people's heads.

Claude's artifacts solve this with types. A deck, a document, a design canvas and a design system are each a kind of artifact with its own viewer, made from files Claude writes, and new ones start from a type with its instructions. A design canvas there is a `canvas.json` index plus one HTML file per board, and a deck or canvas keeps a copy of the design system it was made with.

## Decision

### An artifact is a folder of files

- A version, or a save of a living document, holds a list of files: each a path and a blob hash. A one-file artifact is a list of one, so nothing about today's artifacts changes.
- `publish_artifact` takes a file or a folder from Pi's workspace. A folder names its entry file (`index.html` by default). A file that is the same as in the version before is stored once, as blobs already are.
- The view route serves every file of a version under the artifact's path, in the same sandbox and with the same CSP. A page links its stylesheet, pictures and data by relative path.
- A folder holds up to 200 files and the artifact size limit applies to the whole version.
- The viewer gets a Files view listing the version's files, which changed in that version, and each file's changes. Download gives a `.zip`.
- `read_artifact` copies every file of the version it reads into Pi's folder, at their paths.
- Comments sit on the page or board they were made on. Compare compares the entry page, and for a canvas each board that changed.

### An artifact has a type

- A type says how the viewer draws an artifact. The types are Page, Document (Markdown and design docs, [ADR 0081](0081-artifact-viewer-and-discussion.md)), Slides, Design canvas, Design system, and the file kinds of today (SVG, picture, PDF, CSV).
- The type comes from the folder: a `canvas.json` makes a design canvas, a `deck.html` makes slides, a `tokens.json` with a `README.md` makes a design system. Otherwise it comes from the entry file's kind, as today.
- Slides, canvases and design systems are living documents, as HTML pages are ([ADR 0082](0082-living-markdown-artifacts.md)): Pi publishing again is a save, and versions come from approval, Decided or Save version.

### Templates

- A template is an artifact marked as a template. It has starting files, instructions for Pi, what it is for (present, discuss, design or report), and the design system it uses, if any.
- A template is built in (it ships with Pipoca), shared by an admin with everyone on the server, or someone's own. Someone's own templates work in their personal workspace too. Only admins share one with the server.
- People pick one under Artifacts › New, or from the composer's + menu as "Start from template" in the current Session. Either way it starts a turn that asks Pi to start from it.
- Pi gets three tools:
  - `list_templates(query?, for?)` returns names, type and one line each, so a long catalogue costs little context;
  - `start_artifact(template, title)` copies the starting files into Pi's outputs and returns the template's instructions;
  - `save_template(artifact, scope)` saves an artifact as a template, from any Session, the assistant included. Sharing with the server needs an admin, as in the web.
- What to ask before writing is part of the template's instructions, in words. Pi asks with whatever it has, such as the ask plugin's `ask_user`. The artifacts plugin builds nothing for questions.
- Save as template, in the viewer's menu, keeps either the structure (Pi replaces the content with placeholders) or the whole artifact as an example Pi writes from.
- Built-in templates: slide deck, decision record, design doc, incident review, mockup canvas and report page.

### Decision records

- A decision record is a design doc with an Options section. Each person who reviews it votes for one option or abstains, and the votes show on each option.
- Its Open questions section lists the open Question threads on it, kept by Pi.
- Marking it Decided names the chosen option and Pi writes the Decision section from it, then saves a version ([ADR 0082](0082-living-markdown-artifacts.md)).

### Slides

- A deck is `deck.html` with one `<section>` per slide and an `<aside class="notes">` in each. It may link a stylesheet, pictures and scripts.
- The viewer shows one slide at a time at 16:9, with a rail of slides, the notes below and arrow keys to move. A grid view shows every slide.
- Slides may animate with CSS or script. Elements marked `data-step` appear one per click, in order.
- Comments pin to a slide and an element on it. The grid's "Ask Pi about this slide" items are comments on that slide sent to Pi ([ADR 0081](0081-artifact-viewer-and-discussion.md)).
- Only Pi edits slides. Reordering, duplicating or deleting a slide in the grid asks Pi to do it.
- Present opens the deck fullscreen with a presenter view: the slide, the next one, the notes and a timer. People who open the deck while it is presented follow the presenter's slide and can comment on it.
- Export gives a PDF, one page per slide, with or without notes, through the browser's print of a print stylesheet. There is no PowerPoint export.

### Design canvases

- A canvas follows Claude's layout: `canvas.json` lists each board's file, its frame (`x`, `y`, `w`, `h`), title and page, the order of boards, the pages, and stickies. Each board is a plain HTML file. There is no template language in boards (no `{{holes}}`, loops or tweak props), since only Pi edits them.
- The viewer draws the canvas with pan and zoom, page tabs and a list of boards. Each board renders in its own sandboxed frame, scaled.
- People add stickies and comments. Pi edits boards and adds, moves or removes stickies.
- A board opens on its own, with Play following links between boards, and Compare showing two versions of that board side by side.
- Pi checks what it built against a canvas by reading it: `read_artifact` copies the boards into its folder, and Pi screenshots them and the running app with its Environment's browser. The server does not render boards.

### Design systems

- A design system is an artifact with `tokens.json` (colors, type, spacing), `tokens.css`, a stylesheet, a `README.md` that tells Pi how to use it, and one `components/<Name>/preview.html` per component.
- The viewer shows its colors, type, components and the artifacts that use it.
- An admin can set the server's default; a person can set their own. When nothing is picked, Pi uses the default, asks, or uses none, as the person chose in Settings › Artifacts.
- A deck, canvas or page made with a design system keeps a copy of it in its own files, so a later change to the system never changes an approved artifact. The viewer says when a newer version exists, and Update asks Pi to redraw with it as a new save.
- Pi can make a design system from a repository's styles or a screenshot.

### Not now

- Page powers (shared data the page writes, who is viewing, asking Pi from inside a page) are not built. They would open an API out of the sandbox to untrusted page code, and asking Pi from a page is a way to inject prompts into a Session that holds repository and cloud access.

## Consequences

- Every viewer that shows an artifact reads a list of files instead of one. Today's artifacts become lists of one, in a migration.
- The viewer grows a part per type. Pages, documents and the file kinds keep today's viewer.
- Templates make decks and decision records look alike across the team, and teach Pi the team's shape for a decision without a prompt per Session.
- A canvas and a deck keep their design system's files, which costs storage once per copy. Blobs are stored by hash, so the same file is stored once across artifacts.
- Comparing mockups with the built app needs a browser in the Session's Environment. Sessions without one can read the boards' HTML but not see them.
- Editing boards or slides by hand is not possible; it needs an HTML editor.
