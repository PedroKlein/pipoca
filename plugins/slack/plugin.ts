import { definePlugin } from "@pipoca/plugins";
import { about } from "./about";

export const slack = definePlugin({
  ...about,
  server: async () => import("./src/server"),
  web: async () => import("./web"),
});
