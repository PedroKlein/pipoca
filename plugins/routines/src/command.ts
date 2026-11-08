import type { SessionContext } from "@pipoca/plugins";
import { noticeType } from "@pipoca/protocol";
import type { routines } from "../plugin";
import type { Run } from "./model";

const usage =
  'Run a routine with inputs: /routine <name> key=value key="two words"';

const pair = /^([A-Za-z][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S*))$/;

// `/routine <name> key=value` runs the Session owner's routine of that name
// from any chat (ADR 0075).
export function routineCommand(s: SessionContext<typeof routines>): void {
  s.extension((pi) => {
    pi.registerCommand("routine", {
      description: usage,
      handler: async (args) => {
        const tell = (content: string, title?: string): void => {
          pi.sendMessage({
            customType: noticeType,
            content,
            display: true,
            details: {
              plugin: "routines",
              kind: "routine",
              data: { title: title ?? "/routine" },
            },
          });
        };

        const parsed = parse(args);

        if (parsed === undefined) {
          tell(usage);

          return;
        }

        try {
          const { title, run } = await s.api.post<{
            readonly title: string;
            readonly run: Run;
          }>("invoke", parsed);

          tell(
            run.outcome === "running" || run.outcome === "queued"
              ? `Started ${parsed.name}.`
              : `${parsed.name} didn't start: ${run.reason ?? run.outcome}`,
            title,
          );
        } catch (error) {
          tell(
            `${parsed.name} didn't start: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
  });
}

function parse(
  args: string,
):
  | { readonly name: string; readonly inputs: Record<string, string> }
  | undefined {
  const [name = "", ...rest] = args.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];

  const inputs: Record<string, string> = {};

  for (const each of rest) {
    const [, key = "", quoted, plain] = pair.exec(each) ?? [];

    if (key === "") {
      return undefined;
    }

    inputs[key] = quoted ?? plain ?? "";
  }

  return name === "" ? undefined : { name, inputs };
}
