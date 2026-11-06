import { Config, definePlugin } from "@pipoca/plugins";

export const greeter = definePlugin({
  id: "greeter",
  title: "Greeter",
  description: "Greets you on its own page and with /greet in a Session.",
  config: Config.object({
    greeting: Config.string({ title: "Greeting", default: "Hello" }),
  }),
});
