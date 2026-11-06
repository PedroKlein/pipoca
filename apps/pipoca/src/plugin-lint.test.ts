import { expect, test } from "bun:test";
import { join } from "node:path";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";

const root = join(import.meta.dir, "../../..");

const { default: config } = (await import(join(root, "eslint.config.js"))) as {
  readonly default: readonly Linter.Config[];
};

const kept = new Set([
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-syntax",
]);

// The repository's plugin rules alone, without type information, so a
// file that doesn't exist can be linted.
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    { languageOptions: { parser: tseslint.parser } },
    ...config.flatMap(({ files, ignores, rules }) => {
      const restricted = Object.entries(rules ?? {}).filter(([name]) =>
        kept.has(name),
      );

      return files === undefined || restricted.length === 0
        ? []
        : [
            {
              files,
              ...(ignores && { ignores }),
              rules: Object.fromEntries(restricted),
            },
          ];
    }),
  ],
});

async function problems(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(root, path),
  });

  return (result?.messages ?? []).map(({ message }) => message);
}

test("a plugin tells time by its clock and waits through its schedule", async () => {
  expect(
    await problems(
      "plugins/demo/src/server.ts",
      "export const at = Date.now();\nsetTimeout(() => undefined, 1);\n",
    ),
  ).toEqual([
    "Use clock.now().",
    "Unexpected use of 'setTimeout'. Use schedule.at or schedule.every.",
  ]);

  expect(
    await problems("plugins/demo/plugin.ts", "export const at = new Date();\n"),
  ).toEqual(["Use new Date(clock.now())."]);
});

test("a plugin imports only the SDK, the protocol, the design system and other plugins' definitions", async () => {
  const imports = [
    "@pipoca/plugins",
    "@pipoca/plugins/web",
    "@pipoca/protocol",
    "@pipoca/ui",
    "@pipoca/usage/plugin",
    "@pipoca/plugins/host",
    "@pipoca/pluginhost",
    "@pipoca/sessions",
    "../../../packages/plugins/src/host",
  ];

  const refused = await Promise.all(
    imports.map(
      async (name) =>
        (
          await problems(
            "plugins/demo/src/server.ts",
            `import { x } from "${name}";\nexport const y = x;\n`,
          )
        ).length > 0,
    ),
  );

  expect(refused).toEqual([
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
});
