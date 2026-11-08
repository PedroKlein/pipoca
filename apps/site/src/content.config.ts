import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro/content/config";
import { glob } from "astro/loaders";
import { docsPages, docsSections } from "./docs-links";

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../../docs",
      pattern: [
        ...docsPages,
        ...docsSections.map((section) => `${section}/**/*.md`),
      ],
      generateId: ({ entry }) =>
        `docs/${entry.replace(/(^|\/)README\.md$/, "").replace(/\.md$/, "")}`.replace(
          /\/$/,
          "",
        ),
    }),
    schema: docsSchema(),
  }),
};
