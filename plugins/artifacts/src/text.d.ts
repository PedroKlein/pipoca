// A built-in template's files, which the server embeds as text.
declare module "*.md" {
  const text: string;
  export = text;
}

declare module "*.css" {
  const text: string;
  export = text;
}
