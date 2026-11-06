import { Config, definePlugin } from "@pipoca/plugins";

export const kubernetes = definePlugin({
  id: "kubernetes",
  title: "Kubernetes",
  description:
    "Starts runner pods for an Environment when the server runs in a cluster.",
  works: ["personal", "team"],
  config: Config.object({
    maxPodsPerPerson: Config.number({
      title: "Most runner pods per person",
      description:
        "The most runner pods one person's Environments run at once, on top of each template's own limit.",
      default: 10,
      min: 1,
      max: 1000,
    }),
  }),
});
