import type { PluginDefinition } from "@pipoca/plugins";

// What the plugin is, without its parts, for the web part to import.
export const about = {
  id: "changes",
  title: "Changes",
  description: "Shows a Session's changes as a diff and opens pull requests.",
  works: ["personal", "team"],
} satisfies PluginDefinition;
