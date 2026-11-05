import { definePlugin } from "@pipoca/plugins";

export const checklist = definePlugin({
  id: "checklist",
  title: "Checklist",
  description:
    "Lets the agent keep a checklist of its steps, shown above the composer.",
  works: ["personal", "team"],
  session: async () => import("./src/session"),
  web: async () =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TypeScript follows only a literal, and the server's project has no DOM to check the web part with
    import("./web/index" as string) as Promise<{ readonly default: unknown }>,
});
