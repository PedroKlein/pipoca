import type { PiPackage } from "@pipoca/protocol";

// A package is a source such as npm:name, or a JSON object with Pi's
// filters.
export function packageText(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : JSON.stringify(pkg);
}

export function packageOf(text: string): unknown {
  return text.startsWith("{") ? JSON.parse(text) : text;
}

// Not Profile ids, so no Profile's page can take them.
export const layerHashes = { base: ":base", defaults: ":defaults" } as const;

export type Layer = keyof typeof layerHashes;

// Each layer's routes: the admin's base and each person's own.
export const layerRoutes = {
  base: "settings.baseProfile",
  defaults: "me.profileDefaults",
} as const;

export const layerNames: Readonly<Record<Layer, string>> = {
  base: "Server base",
  defaults: "My defaults",
};

export const chipClass =
  "flex h-7 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-label text-fg hover:bg-hover aria-[current=page]:border-fg-strong aria-[current=page]:bg-fg-strong aria-[current=page]:text-bg";

export const layerAbout: Readonly<Record<Layer, string>> = {
  base: "Every Session on this server, personal and team, loads this under its own Profile. Give everyone skills, instructions, packages, MCP servers and prompts here, and provider extensions so every Session can use their models. People can turn items off in their own Profiles. Only admins change it.",
  defaults:
    "Yours, under every Profile of yours and over the Server base. Put what you want in every Session here, such as your instructions and the providers you use, and turn off what you don't want from the Server base.",
};
