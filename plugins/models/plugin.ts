import { definePlugin } from "@pipoca/plugins";
import { about } from "./about";

export const models = definePlugin({
  ...about,
  server: async () => import("./src/server"),
  session: async () => import("./src/session"),
  web: async () => import("./web"),
});
