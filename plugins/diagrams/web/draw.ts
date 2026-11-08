export type Drawing = { readonly code: string } & (
  { readonly svg: string } | { readonly error: string }
);

const kept = 200;
const drawing = new Map<string, Promise<Drawing>>();
const drawn = new Map<string, Drawing>();
let queue: Promise<unknown> = Promise.resolve();
let count = 0;

const keyOf = (code: string, theme: string): string => `${theme}\n${code}`;

export function drawnBefore(code: string, theme: string): Drawing | undefined {
  return drawn.get(keyOf(code, theme));
}

// Mermaid draws one diagram at a time in a scratch element on the page.
export async function draw(code: string, theme: string): Promise<Drawing> {
  const key = keyOf(code, theme);
  const started = drawing.get(key);

  if (started !== undefined) {
    return started;
  }

  const next = queue.then(async () => drawOnce(code, theme));
  queue = next;
  drawing.set(key, next);

  void next.then((done) => {
    drawn.set(key, done);

    for (const old of [...drawn.keys()].slice(0, -kept)) {
      drawn.delete(old);
      drawing.delete(old);
    }
  });

  return next;
}

async function drawOnce(code: string, theme: string): Promise<Drawing> {
  try {
    const { default: mermaid } = await import("mermaid");

    // Strict mode sanitizes labels and leaves out scripts and click handlers.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: colours(theme),
    });

    await mermaid.parse(code);
    count += 1;
    const { svg } = await mermaid.render(`diagram-${String(count)}`, code);

    return { code, svg };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { code, error: (message.split("\n")[0] ?? "").replace(/:$/, "") };
  }
}

// Mermaid mixes its own shades from these, so it takes colours, not var().
function colours(theme: string): Readonly<Record<string, unknown>> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(name).trim();

  return {
    darkMode: theme !== "light",
    background: token("--bg"),
    primaryColor: token("--bg-elevated"),
    primaryTextColor: token("--text-strong"),
    primaryBorderColor: token("--border-strong"),
    secondaryColor: token("--bg-hover"),
    tertiaryColor: token("--bg-panel"),
    lineColor: token("--text-dim"),
    textColor: token("--text"),
    fontFamily: token("--font-sans"),
  };
}
