import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const docsSections = [
  "get-started",
  "run",
  "use",
  "admin",
  "build-plugins",
  "reference",
] as const;

// Top-level docs that are pages of their own, outside the sections.
export const docsPages = ["README.md", "architecture.md"] as const;

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const docsRoot = resolve(repositoryRoot, "docs");
const base = "/pipoca";

interface Node {
  readonly type: string;
  url?: string;
  readonly children?: readonly Node[];
}

// The docs are plain Markdown that GitHub and Pi read too, so they link to
// each other by relative .md paths. On the site those become page routes, and
// links to anything else in the repository go to it on GitHub.
type Transform = (tree: Node, file: { readonly path: string }) => void;

export function docsLinks(repository: string): () => Transform {
  return () => (tree, file) => {
    visit(tree, (node) => {
      if (node.type === "link" && node.url !== undefined) {
        node.url = siteUrl(node.url, file.path, repository);
      }
    });
  };
}

function siteUrl(url: string, from: string, repository: string): string {
  if (/^([a-z]+:|#|\/)/i.test(url)) {
    return url;
  }

  const at = url.indexOf("#");
  const path = at === -1 ? url : url.slice(0, at);
  const hash = at === -1 ? "" : url.slice(at);
  const target = resolve(dirname(from), path);
  const inDocs = relative(docsRoot, target);

  if (isPage(inDocs)) {
    const id = inDocs.replace(/(^|\/)README\.md$/, "").replace(/\.md$/, "");

    return `${base}/docs/${id === "" ? "" : `${id}/`}${hash}`;
  }

  return `${repository}/blob/main/${relative(repositoryRoot, target)}${hash}`;
}

function isPage(inDocs: string): boolean {
  if ((docsPages as readonly string[]).includes(inDocs)) {
    return true;
  }

  return (
    inDocs.endsWith(".md") &&
    docsSections.some((section) => inDocs.startsWith(`${section}/`))
  );
}

function visit(node: Node, fn: (node: Node) => void): void {
  fn(node);

  for (const child of node.children ?? []) {
    visit(child, fn);
  }
}
