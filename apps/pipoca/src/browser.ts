// Prints the link too, for a machine with no browser to open, such as a
// server reached over SSH. Only printing it leaves the link to whatever ran
// pipoca, such as the desktop app (ADR 0055).
export function openInBrowser(url: string, onlyPrint = false): void {
  process.stderr.write(`sign in at ${url}\n`);

  if (onlyPrint) {
    return;
  }

  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // No opener: the printed link is enough.
  }
}
