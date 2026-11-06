import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "apps/desktop/src-tauri/target/"],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@stylistic": stylistic },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: "block-like", next: "*" },
        {
          blankLine: "always",
          prev: ["multiline-const", "multiline-let", "multiline-expression"],
          next: "*",
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["multiline-const", "multiline-let", "multiline-expression"],
        },
        { blankLine: "always", prev: "*", next: ["function", "class"] },
      ],
      curly: "error",
      eqeqeq: "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-implicit-coercion": "error",
      "no-lonely-if": "error",
      "no-nested-ternary": "error",
      "object-shorthand": "error",
      "no-console": "error",
      "no-param-reassign": "error",
      "prefer-const": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "typeLike", format: ["PascalCase"] },
        {
          selector: "interface",
          format: ["PascalCase"],
          custom: { regex: "^I[A-Z]", match: false },
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/require-array-sort-compare": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-exports": [
        "error",
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    // A v1 example plugin's parts are loaded by their default export
    // (docs/plugins.md).
    files: ["examples/plugins/**/*.ts", "examples/plugins/**/*.tsx"],
    rules: { "no-restricted-exports": "off" },
  },
  {
    // Built-in plugins use only what a third-party plugin gets (ADR 0038).
    files: ["plugins/**/*.ts", "plugins/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@pipoca/(?!(plugins|plugins/testing|plugins/web|plugins/web/testing|protocol|testing|ui|[a-z][a-z0-9-]*/plugin)$)",
              message:
                "Plugins import only @pipoca/plugins, @pipoca/protocol, @pipoca/testing, @pipoca/ui and another plugin's definition, as @pipoca/<id>/plugin.",
            },
            {
              regex: "^\\.\\./\\.\\./",
              message: "Plugins don't import files outside their own folder.",
            },
          ],
        },
      ],
    },
  },
  {
    // A plugin's test may run another plugin's server part beside its own,
    // such as the one whose events it hears.
    files: ["plugins/*/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@pipoca/(?!(plugins|plugins/testing|plugins/web|plugins/web/testing|protocol|testing|ui|[a-z][a-z0-9-]*/plugin|[a-z][a-z0-9-]*/server)$)",
              message:
                "Plugin tests import only what plugins do, and another plugin's server part as @pipoca/<id>/server.",
            },
            {
              regex: "^\\.\\./\\.\\./",
              message: "Plugins don't import files outside their own folder.",
            },
          ],
        },
      ],
    },
  },
  {
    // Plugins tell time by their context's clock and wait through its
    // schedule, so a test's clock moves them too.
    files: ["plugins/*/src/**/*.ts", "plugins/*/src/**/*.tsx"],
    ignores: ["plugins/*/src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["setTimeout", "setInterval"].map((name) => ({
          name,
          message: "Use schedule.at or schedule.every.",
        })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "Use clock.now().",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Use new Date(clock.now()).",
        },
        {
          selector:
            "MemberExpression[object.name='Bun'][property.name='sleep']",
          message: "Use schedule.at or schedule.every.",
        },
        {
          selector: "ImportSpecifier[imported.name=/^set(Timeout|Interval)$/]",
          message: "Use schedule.at or schedule.every.",
        },
      ],
    },
  },
  {
    // No plugin is special: the kernel reaches plugins only through the
    // plugin registries.
    files: [
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "packages/**/*.ts",
      "packages/**/*.tsx",
    ],
    ignores: [
      "apps/pipoca/src/registry-server.ts",
      "apps/pipoca/src/registry-session.ts",
      "apps/web/src/registry.ts",
      // Until these plugins' tests move into the plugins.
      "packages/sessionhost/src/host.test.ts",
      "packages/sessionhost/src/subagents.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^@pipoca/(?!(environments|people|pipoca/plugin-test|pluginhost|plugins|profiles|protocol|repositories|runner|sessionhost|sessions|testing|ui|web|workspaces)(/|$))",
              message: "Only the plugin registries import plugins.",
            },
            {
              regex: "^(\\.\\./)+plugins/",
              message: "Only the plugin registries import plugins.",
            },
          ],
        },
      ],
    },
  },
  {
    // Screens build from @pipoca/ui instead of copying its classes and
    // elements (docs/design-system.md).
    files: [
      "apps/web/src/**/*.ts",
      "apps/web/src/**/*.tsx",
      "plugins/*/web/**/*.ts",
      "plugins/*/web/**/*.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          [
            "rounded-lg border border-line bg-elevated",
            "Use Card, cardClass, linkCardClass or popClass from @pipoca/ui.",
          ],
          [
            "\\bbg-black\\b",
            "Use bg-scrim behind a dialog; the palette has no black.",
          ],
          [
            // Three digits only inside [..] or after a colon, so an
            // anchor such as #add still passes.
            "(^|[\\s\\[:])#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b|(\\[|:\\s?)#[0-9a-fA-F]{3}\\b",
            "Use a colour token from theme.css instead of a hex colour.",
          ],
          [
            "\\buppercase\\b",
            "Labels stay in sentence case (docs/design-system.md).",
          ],
        ].flatMap(([pattern, message]) => [
          { selector: `Literal[value=/${pattern}/]`, message },
          { selector: `TemplateElement[value.raw=/${pattern}/]`, message },
        ]),
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use Select from @pipoca/ui.",
        },
        {
          selector: "JSXOpeningElement[name.name='dialog']",
          message: "Use Dialog or useConfirm from @pipoca/ui.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='input']:has(JSXAttribute[name.name='type'][value.value='file'])",
          message: "Use FileButton from @pipoca/ui.",
        },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
