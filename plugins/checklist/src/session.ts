import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SessionPlugin } from "@pipoca/plugins";
import { type Item, statuses, toolName } from "./list";

const Params = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String({
        description: "The step, in the imperative, like Run the tests",
      }),
      status: StringEnum(statuses),
    }),
    { description: "The whole list, in order. An empty list clears it." },
  ),
});

const updateChecklist = defineTool({
  name: toolName,
  label: "Checklist",
  description:
    "Keep a checklist of your steps, which the user sees above the composer. Use it for work with three or more steps, not for a quick ask. Send the whole list each time. Mark one item in_progress before you start it, and completed as soon as it is done, never before.",
  parameters: Params,
  execute: async (_id, { items }) => {
    const done = items.filter(({ status }) => status === "completed").length;

    return Promise.resolve({
      content: [
        {
          type: "text" as const,
          text: `Checklist updated: ${String(done)} of ${String(items.length)} done.`,
        },
      ],
      details: { items: items satisfies readonly Item[] },
    });
  },
});

// The list lives in each call's result, so the transcript keeps it (ADR 0056).
export const checklist: SessionPlugin = {
  name: "checklist",
  replaceable: true,
  extension: () => (pi) => {
    pi.registerTool(updateChecklist);
  },
};
