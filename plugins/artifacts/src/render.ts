import { preview } from "@pipoca/plugins";
import type { Kind } from "./artifacts";
import { board as boardScript, deck, selection } from "./page";

// The document an artifact's frame shows, which tells the viewer what the
// person selects or clicks, to comment on it. A folder's page may load its
// files from base. A canvas's board tells the viewer the links it follows
// to the other boards under root.
export function rendered(
  kind: Kind,
  name: string,
  content: Uint8Array,
  scriptHosts: readonly string[],
  {
    base,
    slides = false,
    board,
  }: {
    readonly base?: string;
    readonly slides?: boolean;
    readonly board?: string;
  } = {},
): Response {
  return preview(name, content, {
    kind,
    scriptHosts,
    script: `${selection}${slides ? deck : ""}${board === undefined ? "" : boardScript(board)}`,
    ...(base !== undefined && { base }),
  });
}
