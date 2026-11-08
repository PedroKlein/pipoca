import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { docsSidebar } from "./docs-links";

const siteRoot = resolve(import.meta.dir, "..");

test("every sidebar group lists the Markdown pages in its folder", () => {
  const folders = docsSidebar.flatMap((group) =>
    group.items.flatMap((item) =>
      item.autogenerate === undefined ? [] : [item.autogenerate.directory],
    ),
  );

  expect(folders).toHaveLength(docsSidebar.length);

  for (const folder of folders) {
    const pages = readdirSync(resolve(siteRoot, folder)).filter((name) =>
      name.endsWith(".md"),
    );

    expect(pages.length).toBeGreaterThan(0);
  }
});
