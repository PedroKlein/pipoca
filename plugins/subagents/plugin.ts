import { definePlugin } from "@pipoca/plugins";

export const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Lets a Session start subagents and shows their runs.",
  works: ["personal", "team"],
});
