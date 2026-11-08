// What Pi tells packages apart by, ignoring the version or ref: an npm
// package's name, a git repository's host and path, or a local path as
// written (Pi's docs/packages.md, "Understand scope and identity").
export function packageIdentity(source: string): string {
  const trimmed = source.trim();

  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice("npm:".length);
    const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);

    return `npm:${at === -1 ? spec : spec.slice(0, at)}`;
  }

  const url = trimmed.startsWith("git:") ? trimmed.slice("git:".length) : "";

  if (url === "" && !/^(https?|ssh|git):\/\//i.test(trimmed)) {
    return trimmed;
  }

  const repo = (url === "" ? trimmed : url)
    .replace(/#.*$/, "")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/^[^@/]+@/, "")
    .replace(/(\/[^/@]+)@[^/]*$/, "$1")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  const [host = "", ...path] = repo.split("/");

  return `git:${host.toLowerCase()}/${path.join("/")}`;
}
