import type { PluginDefinition } from "@pipoca/plugins";

// What the plugin is, without its parts, for the web part to import.
export const about = {
  id: "subagents",
  title: "Subagents",
  description: "Lets a Session start subagents and shows their runs.",
  works: ["personal", "team"],
} satisfies PluginDefinition;
