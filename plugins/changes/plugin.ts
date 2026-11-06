import { definePlugin } from "@pipoca/plugins";

export const changes = definePlugin({
  id: "changes",
  title: "Changes",
  description: "Shows a Session's changes as a diff and opens pull requests.",
});
