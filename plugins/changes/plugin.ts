import { definePlugin } from "@pipoca/plugins";
import { about } from "./about";

export const changes = definePlugin({
  ...about,
  session: async () => import("./src/session"),
  web: async () => import("./web"),
});
