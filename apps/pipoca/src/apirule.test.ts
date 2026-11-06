import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RouteKey, routes, type RouteSpec } from "@pipoca/protocol";
import { withApiPaths } from "./apirule";

const apiRule = readFileSync(
  join(import.meta.dir, "../../../deploy/helm/pipoca/templates/apirule.yaml"),
  "utf8",
);

interface Rule {
  readonly path: string;
  readonly methods: readonly string[];
  readonly timeout: number | undefined;
}

const allMethods =
  /\{\{- \$methods := list ((?:"[A-Z]+" ?)+)\}\}/
    .exec(apiRule)?.[1]
    ?.split(" ")
    .map((method) => method.replaceAll('"', "")) ?? [];

// The APIRule's rules, with its range of top-level paths spelled out. Rules
// behind a value, such as MCP's, count as on.
const rules: readonly Rule[] = apiRule
  .replace(
    / *\{\{- range list ((?:"[a-z-]+" ?)+)\}\}\n([\s\S]*?) *\{\{- end \}\}\n/,
    (_, names: string, body: string) =>
      names
        .split(" ")
        .map((name) => body.replaceAll("{{ . }}", name.replaceAll('"', "")))
        .join(""),
  )
  .split("\n    - path: ")
  .slice(1)
  .map((rule) => {
    const methods = /^ {6}methods: (.+)$/m.exec(rule)?.[1] ?? "";
    const timeout = /^ {6}timeout: (\d+)$/m.exec(rule)?.[1];

    return {
      path: rule.split("\n")[0] ?? "",
      methods: methods.includes("$methods")
        ? allMethods
        : methods.replace(/[[\]\s]/g, "").split(","),
      timeout: timeout === undefined ? undefined : Number(timeout),
    };
  });

// Kyma's path patterns: {*} is one segment and {**} any number of them.
function matches(pattern: string, path: string): boolean {
  const wildcards: Readonly<Record<string, string>> = {
    "{**}": ".*",
    "{*}": "[^/]+",
  };

  const regex = pattern
    .split("/")
    .map(
      (part) => wildcards[part] ?? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");

  return new RegExp(`^${regex}$`).test(path);
}

// A path the route answers, with a sample for each parameter.
function sampleOf(spec: RouteSpec): string {
  return spec.path
    .split("/")
    .map((part) => {
      if (part.startsWith("*")) {
        return "x/y";
      }

      return part.startsWith(":") ? "x" : part;
    })
    .join("/");
}

function ruleFor(spec: RouteSpec): Rule | undefined {
  const path = sampleOf(spec);
  const methods = spec.method === "ANY" ? ["GET", "POST"] : [spec.method];

  return rules.find(
    (rule) =>
      matches(rule.path, path) &&
      methods.every((method) => rule.methods.includes(method)),
  );
}

const table = Object.entries(routes) as [RouteKey, RouteSpec][];

// Making the first account works only through a port-forward.
const unlisted: readonly RouteKey[] = ["auth.setup"];

// The gateway refuses any path its APIRule doesn't list, so a route missing
// from it works through a port-forward and fails on Kyma.
test("the APIRule lets through every route the server serves", () => {
  expect(
    table
      .filter(([key, spec]) => !unlisted.includes(key) && !ruleFor(spec))
      .map(([key, spec]) => `${key}: ${spec.method} ${spec.path}`),
  ).toEqual([]);

  expect(unlisted.filter((key) => ruleFor(routes[key]))).toEqual([]);
});

// Plugins' routes are compiled at boot, so the route table doesn't list
// them, and the gateway must let all of /api/ext through.
test("the APIRule lets through plugins' routes under /api/ext", () => {
  const samples = [
    "/api/ext/oidc/start/ias",
    "/api/ext/oidc/callback",
    "/api/ext/git-hosts/callback",
    "/api/ext/routines/hooks/x",
    "/api/ext/logins/proxy/anthropic/v1/messages",
    "/api/ext/projects",
  ];

  expect(
    samples.filter(
      (path) =>
        !rules.some(
          (rule) =>
            matches(rule.path, path) &&
            allMethods.every((method) => rule.methods.includes(method)),
        ),
    ),
  ).toEqual([]);
});

// Team Sessions' model calls go through the logins proxy at the public
// host, and a long answer streams for longer than the gateway's 180 seconds.
test("the APIRule keeps plugins' routes open as long as Kyma allows", () => {
  expect(
    rules.find(({ path }) =>
      matches(path, "/api/ext/logins/proxy/anthropic/v1/messages"),
    )?.timeout,
  ).toBe(3900);
});

test("the APIRule lists the route table's paths, as bun run apirule writes them", () => {
  expect(withApiPaths(apiRule)).toBe(apiRule);
});

// Kyma's gateway ends a request after 180 seconds unless its rule says
// otherwise, which would cut change feeds, Session event streams, terminals
// and MCP streams. 3900 seconds is the most an APIRule allows.
test("the APIRule keeps streams open as long as Kyma allows", () => {
  const streams = table.filter(
    ([key, spec]) => spec.response === "stream" || key === "mcp",
  );

  expect(streams.length).toBeGreaterThan(3);

  expect(
    streams
      .filter(([, spec]) => ruleFor(spec)?.timeout !== 3900)
      .map(([key]) => key),
  ).toEqual([]);
});

// Runner pods reach the server through its Service, which the gateway's
// policies would shut out but for this one.
test("the APIRule's policy lets runner pods reach their routes", () => {
  const paths =
    /paths: \[(.+)\]/
      .exec(apiRule)?.[1]
      ?.split(", ")
      .map((path) => path.replaceAll('"', "")) ?? [];

  const runners = table.filter(([key]) => key.startsWith("runner."));

  expect(runners.length).toBeGreaterThan(10);

  expect(
    runners
      .filter(
        ([, spec]) =>
          !paths.some((path) =>
            sampleOf(spec).startsWith(path.replace(/\*$/, "")),
          ),
      )
      .map(([key]) => key),
  ).toEqual([]);
});
