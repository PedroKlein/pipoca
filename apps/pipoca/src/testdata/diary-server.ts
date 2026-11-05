import { defineServer } from "@pipoca/plugins";
import { diary } from "./notes";

export default defineServer(diary, ({ routes }) => {
  routes.scoped("pages", (scoped) => {
    scoped.get("", {}, ({ owner }) => ({ owner }));
  });
});
