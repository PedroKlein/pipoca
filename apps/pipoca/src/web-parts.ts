import { partsLeftOut } from "./bundle";

// The web app's bundle imports each built-in web part from its registry, so
// it leaves out what plugin.ts loads, which is the server's to run.
const parts = partsLeftOut((path) =>
  /[\\/]plugins[\\/][^\\/]+[\\/]plugin\.ts$/.test(path),
);

export default {
  name: "web-parts",
  setup: async (build) => {
    if (build.config.target === "browser") {
      await parts.setup(build);
    }
  },
} satisfies Bun.BunPlugin;
