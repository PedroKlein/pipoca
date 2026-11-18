const origin = "http://pipoca.internal";

// A path stays under its own routes: dot segments, plain, percent-encoded
// or spelled with backslashes and tabs the address parser drops, or a "#",
// would let input such as an id name another route.
export function routeUrl(path: string, base: string): string | undefined {
  const [pathname = ""] = path.split("?");

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

  return dotted || path.includes("#") || !url.pathname.startsWith(base)
    ? undefined
    : url.href;
}
