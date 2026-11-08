import { defineSession } from "@pipoca/plugins";
import { ask } from "../plugin";
import { askUser } from "./ask";

// ask_user replaces a user's own extension of that name, because Pipoca's
// web UI can't draw a terminal extension's custom dialogs.
export const session = defineSession(ask, (s) => {
  s.tools.define(askUser(s));
});
