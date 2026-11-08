import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { docsLinks } from "./src/docs-links";

const repository = "https://github.com/PedroKlein/pipoca";

export default defineConfig({
  site: "https://pipoca.dev",
  base: "/",
  trailingSlash: "always",
  markdown: { processor: unified({ remarkPlugins: [docsLinks(repository)] }) },
  vite: { server: { fs: { allow: ["../.."] } } },
  integrations: [
    starlight({
      title: "Pipoca",
      description:
        "Self-hosted Pi coding-agent sessions for you and your team, on your own machines.",
      logo: {
        light: "./src/assets/mark-light.svg",
        dark: "./src/assets/mark-dark.svg",
        alt: "",
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/apps/site/` },
      customCss: [
        "@fontsource/hanken-grotesk/400.css",
        "@fontsource/hanken-grotesk/500.css",
        "@fontsource/hanken-grotesk/600.css",
        "@fontsource/jetbrains-mono/400.css",
        "@fontsource/newsreader/300.css",
        "./src/styles/theme.css",
      ],
      sidebar: [
        {
          label: "Get started",
          items: [{ autogenerate: { directory: "docs/get-started" } }],
        },
        {
          label: "Ways to run",
          items: [{ autogenerate: { directory: "docs/run" } }],
        },
        {
          label: "Use Pipoca",
          items: [{ autogenerate: { directory: "docs/use" } }],
        },
        {
          label: "Administer",
          items: [{ autogenerate: { directory: "docs/admin" } }],
        },
        {
          label: "Build plugins",
          items: [{ autogenerate: { directory: "docs/build-plugins" } }],
        },
        {
          label: "Reference",
          items: [
            { autogenerate: { directory: "docs/reference" } },
            { label: "Architecture", slug: "docs/architecture" },
          ],
        },
      ],
    }),
  ],
});
