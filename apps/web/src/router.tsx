import { useMemo, useSyncExternalStore } from "react";

// Every page of the app by its address after #. A :name? part may be left
// out, and a last *name takes the rest of the address. The first match wins.
const table = {
  home: "",
  getStarted: "get-started/:step",
  settings: "settings/:page?/*rest",
  teamSetup: "team/setup/:section?/*rest",
  teamSession: "team/sessions/:id",
  teamSessions: "team/sessions",
  teamPage: "team/page/:id",
  teamPlugin: "team/plugin/:plugin/:key",
  team: "team",
  plugin: "plugin/:name/*path",
  setup: "setup/:token",
  join: "join/:token",
  app: "app/:challenge",
  session: ":id",
} as const;

type Table = typeof table;

export type RouteName = keyof Table;

type Segments<Pattern extends string> =
  Pattern extends `${infer Head}/${infer Rest}`
    ? Head | Segments<Rest>
    : Pattern;

type RequiredName<Segment extends string> = Segment extends `:${infer Name}`
  ? Name extends `${string}?`
    ? never
    : Name
  : never;

type OptionalName<Segment extends string> = Segment extends `:${infer Name}?`
  ? Name
  : Segment extends `*${infer Name}`
    ? Name
    : never;

type Names<N extends RouteName> =
  | RequiredName<Segments<Table[N]>>
  | OptionalName<Segments<Table[N]>>;

export type HrefParams<N extends RouteName> = Readonly<Record<RequiredName<Segments<Table[N]>>, string>> & Readonly<Partial<Record<OptionalName<Segments<Table[N]>>, string>>>;

export type Route = {
  [N in RouteName]: {
    readonly name: N;
    // A part left out of the address is "".
    readonly params: Readonly<Record<Names<N>, string>>;
  };
}[RouteName];

type HrefArgs<N extends RouteName> = [Names<N>] extends [never]
  ? []
  : [RequiredName<Segments<Table[N]>>] extends [never]
    ? [params?: HrefParams<N>]
    : [params: HrefParams<N>];

const names = Object.keys(table) as RouteName[];

function match(
  pattern: string,
  parts: readonly string[],
): Record<string, string> | undefined {
  const wanted = pattern === "" ? [] : pattern.split("/");
  const params: Record<string, string> = {};

  for (const [index, segment] of wanted.entries()) {
    const part = parts[index];

    if (segment.startsWith("*")) {
      params[segment.slice(1)] = parts.slice(index).join("/");

      return params;
    }

    if (segment.startsWith(":") && segment.endsWith("?")) {
      params[segment.slice(1, -1)] = part ?? "";
    } else if (segment.startsWith(":") && part !== undefined && part !== "") {
      params[segment.slice(1)] = part;
    } else if (segment !== part) {
      return undefined;
    }
  }

  return parts.length <= wanted.length ? params : undefined;
}

// The page an address opens, from location.hash with or without its #.
export function parse(hash: string): Route {
  const address = hash.replace(/^#/, "").replace(/\/+$/, "");
  const parts = address === "" ? [] : address.split("/");

  for (const name of names) {
    const params = match(table[name], parts);

    if (params !== undefined) {
      return { name, params } as Route;
    }
  }

  return { name: "home", params: {} };
}

// The link to a page, such as #settings/profiles/p1.
export function href<N extends RouteName>(
  name: N,
  ...[params]: HrefArgs<N>
): string {
  return build(table[name], params ?? {});
}

// The link back to a page the address opened.
export function routeHref(route: Route): string {
  return build(table[route.name], route.params);
}

function build(
  pattern: string,
  given: Readonly<Record<string, string | undefined>>,
): string {
  const parts = pattern.split("/").flatMap((segment) => {
    if (!segment.startsWith(":") && !segment.startsWith("*")) {
      return segment === "" ? [] : [segment];
    }

    const value = given[segment.replace(/^[:*]/, "").replace(/\?$/, "")] ?? "";

    return value === "" ? [] : [value];
  });

  return `#${parts.join("/")}`;
}

// Environments and Profiles are a person's in Settings, and the team's in
// Team setup.
export function scopedHref(
  team: boolean,
  page: "environments" | "profiles",
  rest = "",
): string {
  return team
    ? href("teamSetup", { section: page, rest })
    : href("settings", { page, rest });
}

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) {
    location.replace(to);
  } else {
    location.hash = to;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
  };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);

  return useMemo(() => parse(hash), [hash]);
}
