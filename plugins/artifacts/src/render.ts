import { preview } from "@pipoca/plugins";
import type { Kind } from "./artifacts";
import { selection } from "./page";

// The document an artifact's frame shows, which tells the viewer what the
// person selects or clicks, to comment on it. A folder's page may load its
// files from base.
export function rendered(
  kind: Kind,
  name: string,
  content: Uint8Array,
  scriptHosts: readonly string[],
  base?: string,
): Response {
  return preview(name, content, {
    kind,
    scriptHosts,
    script: selection,
    ...(base !== undefined && { base }),
  });
}
