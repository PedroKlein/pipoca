const origin = "http://pipoca.internal";

// A path stays under its own routes on this server: dot segments, plain,
// percent-encoded or spelled with backslashes and the characters the
// address parser drops, a "#", or a "//" naming another host would let
// input such as an id name another route.
export function routeUrl(path: string, base: string): string | undefined {
  const [pathname = ""] = path
    // The parser strips these control characters from both ends.
    // eslint-disable-next-line no-control-regex
    .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "")
    .split("?");

  const dotted = pathname.split(/[/\\]/).some((segment) => {
    try {
      return [".", ".."].includes(
        decodeURIComponent(segment).replace(/[\t\n\r]/g, ""),
      );
    } catch {
      return true;
    }
  });

  const url = new URL(path, origin);

  return dotted ||
    path.includes("#") ||
    url.origin !== origin ||
    !url.pathname.startsWith(base)
    ? undefined
    : url.href;
}
