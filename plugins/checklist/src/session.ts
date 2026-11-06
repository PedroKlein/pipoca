import { defineSession, StringEnum, Type } from "@pipoca/plugins";
import { checklist } from "../plugin";
import { statuses, toolName } from "./items";

const params = Type.Object({
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

// The list lives in each call's result, so the transcript keeps it (ADR 0056).
export const session = defineSession(checklist, (s) => {
  s.tools.define({
    name: toolName,
    label: "Checklist",
    description:
      "Keep a checklist of your steps, which the user sees above the composer. Use it for work with three or more steps, not for a quick ask. Send the whole list each time. Mark one item in_progress before you start it, and completed as soon as it is done, never before.",
    params,
    replaceable: true,
    run: ({ items }) => {
      const done = items.filter(({ status }) => status === "completed").length;

      return {
        text: `Checklist updated: ${String(done)} of ${String(items.length)} done.`,
        details: { items },
      };
    },
  });
});
