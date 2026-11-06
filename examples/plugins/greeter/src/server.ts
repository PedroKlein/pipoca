import { defineServer } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const server = defineServer(greeter, ({ config, routes }) => {
  routes.get("greeting", { auth: "person" }, () => ({
    greeting: config.get().greeting,
  }));
});
