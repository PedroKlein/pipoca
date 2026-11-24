# Pipoca

Pipoca's own look: ink on warm paper, one butter highlight, and plain sentences. Use it for decks, canvases and pages.

## How to use it

- Link `design-system/tokens.css`, then `design-system/bundle.css`, from every page, slide deck and board, before your own stylesheet.
- Take colours, fonts, spacing and radii from the variables in `tokens.css`, such as `var(--ink)` and `var(--space-4)`. Don't write a hex value or a font name of your own.
- Start from the components: copy the markup of `components/<Name>/preview.html` and keep its `pp-` classes.

## Rules

- Ink and paper carry everything. Use `--accent` once per screen, for the one thing to remember.
- `--good`, `--warn` and `--bad` mean a state, never decoration, and always come with a word.
- Headlines are sentences that state the point. Sentence case everywhere, no uppercase labels.
- Charts are inline SVG in `--chart-1` to `--chart-4`, with the source in a `pp-caption` under them.
- A slide keeps the `display` style for its title slide only; other slides use `heading`.
