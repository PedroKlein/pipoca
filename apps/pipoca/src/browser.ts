// Prints the link too, for a machine with no browser to open, such as a
// server reached over SSH.
export function openInBrowser(url: string): void {
  process.stderr.write(`sign in at ${url}\n`);

  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // No opener: the printed link is enough.
  }
}
