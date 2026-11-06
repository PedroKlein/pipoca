import { defineServer } from "@pipoca/plugins";
import { diary } from "./notes";

export const server = defineServer(diary, ({ routes }) => {
  routes.get("pages", { auth: "person", team: true }, ({ caller }) => ({
    owner: caller.owner,
  }));
});
