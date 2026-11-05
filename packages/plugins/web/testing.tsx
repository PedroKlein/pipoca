import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  type ComponentType,
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PluginDefinition } from "../src/definition";
import type { MountedSession, WebPart } from "./index";
import { PluginScope, type Shell, ShellProvider } from "./shell";

// React reads the page when it loads, so a part's test imports this module
// before the part, and the page exists by then.
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { createRoot } = await import("react-dom/client");

// A plugin's part as the web app draws it, for the plugin's own tests: for a
// signed-in person, with other plugins' parts filling slots by name.
export function TestShell({
  plugin,
  fills = {},
  children,
}: {
  readonly plugin: Pick<PluginDefinition, "id">;
  readonly fills?: Readonly<Record<string, ComponentType<never>>>;
  readonly children: ReactNode;
}): ReactElement {
  const shell: Shell = {
    viewer: {
      person: { id: "ana", name: "Ana", admin: false },
      admin: false,
      team: false,
    },
    fills: (slot) => {
      const Component = fills[slot];

      return Component === undefined ? [] : [{ plugin: "other", Component }];
    },
    part: (_plugin, child): ReactNode => child,
    href: (id, path) => `#plugin/${id}/${path}`,
    SessionView: ({ sessionId }) => <p>Session {sessionId}</p>,
  };

  return (
    <ShellProvider shell={shell}>
      <PluginScope plugin={plugin.id}>{children}</PluginScope>
    </ShellProvider>
  );
}

// Draws what a part fills a slot with, inside the test shell, on a page that
// is taken down after the test.
export function renderPart(
  part: WebPart,
  slot: string,
  props: object,
  o: {
    readonly fills?: Readonly<Record<string, ComponentType<never>>>;
    // What the page's requests get, in place of the network.
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
): HTMLElement {
  const Part = (part.slots as Readonly<Record<string, unknown>> | undefined)?.[
    slot
  ] as ComponentType<object> | undefined;

  if (Part === undefined) {
    throw new Error(`${part.plugin.id} fills no ${slot}`);
  }

  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }

  // Set once the page exists, which brings a fetch of its own.
  const realFetch = globalThis.fetch;

  if (o.fetch) {
    const fake = o.fetch;

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof input === "string") {
          return fake(input, init);
        }

        return fake(input instanceof URL ? input.href : input.url, init);
      },
      { preconnect: realFetch.preconnect },
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(TestShell, {
        plugin: part.plugin,
        ...(o.fills && { fills: o.fills }),
        children: createElement(Part, props),
      }),
    );
  });

  // Inside a test, this runs once the test ends.
  afterAll(async () => {
    act(() => {
      root.unmount();
    });

    globalThis.fetch = realFetch;

    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });

  return container;
}

export interface ToolResultRow {
  readonly tool: string;
  readonly text?: string;
  readonly details?: unknown;
  readonly isError?: boolean;
}

// A Session whose stream replays these tool calls' results and what its
// parts published.
export function sessionWith(o: {
  readonly toolResults?: readonly ToolResultRow[];
  readonly published?: readonly {
    readonly plugin: string;
    readonly key: string;
    readonly data: unknown;
  }[];
}): MountedSession {
  const entries = (o.toolResults ?? []).flatMap(
    ({ tool, text = "", details = {}, isError = false }, at) => {
      const id = `call-${String(at)}`;

      return [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id, name: tool, arguments: {} }],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: id,
            toolName: tool,
            content: [{ type: "text", text }],
            details,
            isError,
          },
        },
      ];
    },
  );

  return {
    id: "session-1",
    events: (listener) => {
      entries.forEach((entry, line) => {
        listener({ type: "entry", line, entry: JSON.stringify(entry) });
      });

      for (const event of o.published ?? []) {
        listener({ type: "live", event: { type: "plugin", ...event } });
      }

      return () => undefined;
    },
    send: async () => Promise.resolve(),
  };
}
