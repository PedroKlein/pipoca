import { definePlugin } from "@pipoca/plugins";

export const checklist = definePlugin({
  id: "checklist",
  title: "Checklist",
  description:
    "Lets the agent keep a checklist of its steps, shown above the composer.",
});
