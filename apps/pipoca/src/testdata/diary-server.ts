import { defineServer } from "@pipoca/plugins";
import { diary } from "./notes";

export const server = defineServer(diary, ({ routes }) => {
  routes.scoped("pages", (scoped) => {
    scoped.get("", {}, ({ owner }) => ({ owner }));
  });
});
