import { definePlugin } from "@pipoca/plugins";

export const diagrams = definePlugin({
  id: "diagrams",
  title: "Diagrams",
  description:
    "Draws Mermaid diagrams in chat and tells the agent when to use one.",
});
