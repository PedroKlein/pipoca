import {
  fieldsOf,
  isHttpError,
  type Person,
  type RouteRequest,
  type ServerTool,
  type ToolCall,
  type ToolDef,
  type Toolset,
} from "@pipoca/plugins";
import { checkBody, isToolError } from "@pipoca/plugins/host";
import {
  type Log,
  type Method,
  type RouteSpec,
  type RouteToolSpec,
  routes,
  type Session,
  type ToolResult,
  type ToolSpec,
  type UiAction,
} from "@pipoca/protocol";
import { type TObject, type TSchema, Type } from "typebox";
import type { OnBehalf } from "./host";

type Input = Readonly<Record<string, unknown>>;

// A tool that runs on the server for a Session.
export interface ServedTool {
  readonly plugin: string;
  readonly spec: ToolSpec;
  readonly applies: (session: Session) => boolean;
  readonly question?: (
    input: unknown,
    session: Session,
  ) => Promise<string | undefined>;
  readonly run: (input: unknown, session: Session) => Promise<ToolResult>;
}

// A tool that is a request to a route, made as a person (ADR 0035). A
// plugin's paths are relative to its own routes; the kernel's start at /api/.
export interface RouteTool {
  // Undefined for the kernel's own routes.
  readonly plugin: string | undefined;
  readonly spec: ToolSpec;
  readonly internal: boolean;
  readonly request: (input: Input) => RouteRequest;
  readonly asks?: RouteToolSpec["asks"];
  readonly result?: RouteToolSpec["result"];
  readonly opens?: RouteToolSpec["opens"];
}

export type Api = (onBehalf: OnBehalf, request: Request) => Promise<Response>;

export function kernelRouteTools(): RouteTool[] {
  return Object.values(routes).flatMap((spec: RouteSpec) =>
    spec.method === "ANY"
      ? []
      : routeTools(undefined, { ...spec, method: spec.method }, spec.tool),
  );
}

export function routeTools(
  plugin: string | undefined,
  route: {
    readonly method: Exclude<Method, "ANY">;
    readonly path: string;
    readonly query?: TSchema | undefined;
    readonly body?: TSchema | "bytes" | undefined;
  },
  tools: RouteToolSpec | readonly RouteToolSpec[] | undefined,
): RouteTool[] {
  const listed: readonly RouteToolSpec[] = [tools ?? []].flat();

  const names = route.path
    .split("/")
    .flatMap((part) =>
      part.startsWith(":") || part.startsWith("*") ? [part.slice(1)] : [],
    );

  const query =
    route.query !== undefined && Type.IsObject(route.query)
      ? route.query.properties
      : {};

  return listed.map((tool) => {
    const { name, description, namespace, annotations } = tool;

    const parameters =
      tool.params ?? defaultParams(name, names, query, route.body);

    return {
      plugin,
      internal: tool.internal === true,
      spec: {
        name,
        description,
        parameters: { ...parameters },
        exposure: tool.exposure ?? "deferred",
        ...(namespace && { namespace }),
        ...(annotations && { annotations }),
      },
      request: requestOf(route, names, Object.keys(query), tool.body),
      ...(tool.asks && { asks: tool.asks }),
      ...(tool.result && { result: tool.result }),
      ...(tool.opens && { opens: tool.opens }),
    };
  });
}

function defaultParams(
  tool: string,
  names: readonly string[],
  query: TObject["properties"],
  body: TSchema | "bytes" | undefined,
): TObject {
  if (body !== undefined && (body === "bytes" || !Type.IsObject(body))) {
    throw new Error(
      `tool ${tool} needs params, since its route's body isn't an object`,
    );
  }

  return Type.Object(
    {
      ...Object.fromEntries(names.map((name) => [name, Type.String()])),
      ...query,
      ...body?.properties,
    },
    { additionalProperties: false },
  );
}

function requestOf(
  route: {
    readonly method: Exclude<Method, "ANY">;
    readonly path: string;
    readonly body?: unknown;
  },
  names: readonly string[],
  queried: readonly string[],
  fixed: Input | undefined,
): (input: Input) => RouteRequest {
  const { method } = route;
  const reads = method === "GET" || method === "DELETE";
  const sends = route.body !== undefined || fixed !== undefined;

  return (input) => {
    const path = route.path
      .split("/")
      .map((part) =>
        part.startsWith(":") || part.startsWith("*")
          ? encodeURIComponent(textIn(input, part.slice(1)))
          : part,
      )
      .join("/");

    const rest = Object.entries(input).filter(
      ([name, value]) => !names.includes(name) && value !== undefined,
    );

    const inQuery = rest.filter(([name]) => reads || queried.includes(name));
    const inBody = rest.filter((entry) => !inQuery.includes(entry));

    const search = new URLSearchParams(
      inQuery.map(([name, value]): [string, string] => [
        name,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    ).toString();

    return {
      method,
      path: search === "" ? path : `${path}?${search}`,
      ...(!reads &&
        sends && { body: { ...Object.fromEntries(inBody), ...fixed } }),
    };
  };
}

// A plugin's toolset (v1): its full names are <namespace>_<name>.
export function toolsetTools(toolset: Toolset, plugin: string): RouteTool[] {
  const { namespace } = toolset;

  return toolset.tools.map((tool) => {
    const { request, result, opens, asks, internal, name, exposure, ...spec } =
      tool;

    return {
      plugin,
      internal: internal === true,
      spec: {
        ...spec,
        name: `${namespace.name}_${name}`,
        exposure: exposure ?? "deferred",
        namespace,
      },
      request,
      ...(asks && { asks }),
      ...(result && { result }),
      ...(opens && { opens }),
    };
  });
}

export function registeredTool(plugin: string, tool: ServerTool): ServedTool {
  const { appliesTo, run, ...spec } = tool;

  return {
    plugin,
    spec,
    applies: appliesTo,
    run: async (input, session) =>
      run(input, { session, actor: `session:${session.id}` }),
  };
}

export function definedTool(
  plugin: string,
  tool: ToolDef,
  deps: {
    readonly person: (id: string) => Person | undefined;
    readonly log: Log;
  },
): ServedTool {
  const { when, asks } = tool;

  const callOf = (session: Session): ToolCall => {
    const person =
      session.startedBy === null ? undefined : deps.person(session.startedBy);

    return { session, owner: session.ownedBy, ...(person && { person }) };
  };

  const valid = (input: unknown): unknown => checkBody(input, tool.params);

  return {
    plugin,
    spec: {
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.params },
      ...(tool.label !== undefined && { label: tool.label }),
      ...(tool.exposure !== undefined && { exposure: tool.exposure }),
      ...(tool.annotations && {
        annotations: {
          ...(tool.annotations.readOnly !== undefined && {
            readOnlyHint: tool.annotations.readOnly,
          }),
          ...(tool.annotations.destructive !== undefined && {
            destructiveHint: tool.annotations.destructive,
          }),
        },
      }),
    },
    applies: (session) => {
      const owner = when?.owner ?? "any";
      const call = callOf(session);

      return (
        (owner === "any" || (owner === "team") === (call.owner === "team")) &&
        (when?.ownSessions !== true || session.owner?.plugin === plugin) &&
        (when?.available?.(session, call.person) ?? true)
      );
    },
    ...(asks && {
      question: async (input, session) => {
        try {
          return await asks(valid(input), callOf(session));
        } catch {
          return undefined;
        }
      },
    }),
    run: async (input, session) => {
      let checked: unknown;

      try {
        checked = valid(input);
      } catch (error) {
        return { text: messageOf(error), isError: true };
      }

      try {
        const output = await tool.run(checked, callOf(session));

        return typeof output === "string"
          ? { text: output, isError: false }
          : {
              text: output.text,
              isError: false,
              ...(output.details !== undefined && { details: output.details }),
            };
      } catch (error) {
        if (isToolError(error) || isHttpError(error)) {
          return { text: error.message, isError: true };
        }

        deps.log("tool failed", { tool: tool.name, error: messageOf(error) });

        return { text: "The tool failed", isError: true };
      }
    },
  };
}

// A route of the web app such as a Session id or <project id>/<thread id>,
// so what a tool opens stays a page of Pipoca.
const appRoute = /^[\w-]+(\/[\w-]+)*$/;

// Never sent anywhere: the request goes straight to the server's handler.
const internalOrigin = "http://pipoca.internal";

export async function runRouteTool(
  found: RouteTool,
  input: unknown,
  onBehalf: OnBehalf,
  api: Api,
  open: (action: UiAction) => void,
): Promise<ToolResult> {
  const { method, path, body } = found.request(fieldsOf(input));
  const base = baseOf(found);

  const url = routeUrl(found.plugin === undefined ? path : base + path, base);

  if (url === undefined) {
    return { text: `${path} isn't one of its routes`, isError: true };
  }

  const response = await api(
    onBehalf,
    new Request(
      url,
      body === undefined
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  );

  const text = await response.text();

  if (!response.ok) {
    return {
      text: text || `failed with ${String(response.status)}`,
      isError: true,
    };
  }

  if (text === "") {
    return { text: "Done.", isError: false };
  }

  // The change is made by now, so a reply the tool can't read is still a
  // success; an error would make the model try again.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, isError: false };
  }

  try {
    const opens = found.opens?.(parsed);

    const opened: UiAction | undefined =
      opens !== undefined && appRoute.test(opens.route)
        ? {
            kind: "open",
            route:
              found.plugin === undefined
                ? opens.route
                : `plugin/${found.plugin}/${opens.route}`,
            label: opens.label,
          }
        : undefined;

    if (opened !== undefined) {
      open(opened);
    }

    return {
      text: JSON.stringify(found.result ? found.result(parsed) : parsed),
      isError: false,
      ...(opened && { opened }),
    };
  } catch {
    return { text: "Done, with a reply it couldn't show.", isError: false };
  }
}

export async function routeToolQuestion(
  found: RouteTool,
  input: unknown,
  onBehalf: OnBehalf,
  api: Api,
): Promise<string | undefined> {
  const { asks } = found;

  if (asks === undefined) {
    return undefined;
  }

  const fields = fieldsOf(input);
  const path = asks.lookup?.(fields);
  const base = baseOf(found);

  const url =
    path === undefined
      ? undefined
      : routeUrl(found.plugin === undefined ? path : base + path, base);

  let looked: unknown;
  if (url !== undefined) {
    try {
      const response = await api(onBehalf, new Request(url));
      looked = response.ok ? await response.json() : undefined;
    } catch {
      looked = undefined;
    }
  }

  return asks.text(fields, looked);
}

function baseOf(found: RouteTool): string {
  return found.plugin === undefined ? "/api/" : `/api/ext/${found.plugin}/`;
}

// A tool's path stays under its own routes: dot segments, plain or
// percent-encoded, would let input such as an id name another route.
function routeUrl(path: string, base: string): string | undefined {
  const [pathname = ""] = path.split("?");

  const dotted = pathname.split("/").some((segment) => {
    try {
      return [".", ".."].includes(decodeURIComponent(segment));
    } catch {
      return true;
    }
  });

  const url = new URL(path, internalOrigin);

  return dotted || !url.pathname.startsWith(base) ? undefined : url.href;
}

function textIn(input: Input, key: string): string {
  const value = input[key];

  return typeof value === "string" ? value : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
