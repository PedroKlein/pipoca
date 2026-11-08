import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { docsLinks, docsSidebar } from "./src/docs-links";

const repository = "https://github.com/PedroKlein/pipoca";
const site = "https://pipoca.dev";
const socialImage = `${site}/og.png`;

export default defineConfig({
  site,
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
      head: [
        {
          tag: "meta",
          attrs: { property: "og:image", content: socialImage },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:image", content: socialImage },
        },
      ],
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
      sidebar: docsSidebar,
    }),
  ],
});
