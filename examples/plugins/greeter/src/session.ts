import { defineSession } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const session = defineSession(greeter, (s) => {
  s.extension((pi) => {
    pi.registerCommand("greet", {
      description: "Say the greeting from the Greeter plugin's config",
      handler: async (_args, ctx) => {
        const { greeting } = await s.api.get<{ greeting: string }>("greeting");

        ctx.ui.notify(`${greeting} from ${ctx.cwd}`, "info");
      },
    });
  });
});
