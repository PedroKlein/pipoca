import { watchChanges } from "@pipoca/plugins/web";
import {
  type ApiArgs,
  type ApiClient,
  apiClient,
  type ApiInput,
  type ApiReply,
  type RouteKey,
  type RouteSpec,
  routes,
} from "@pipoca/protocol";
import { createStore } from "./store";

export const store = createStore(watchChanges);

const client = apiClient();

// The server's routes by name, typed by its route table. What a request
// changes is read again at once, before the server's change event arrives.
export const request: ApiClient = Object.assign(
  async <Key extends RouteKey>(
    key: Key,
    ...args: ApiArgs<Key>
  ): Promise<ApiReply<Key>> => {
    const reply = await client(key, ...args);
    const spec: RouteSpec = routes[key];

    if (spec.changes !== undefined) {
      store.invalidate(spec.changes);
    }

    return reply;
  },
  { response: client.response },
);

// What a person reads when something failed.
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type BrowserCommand = ApiInput<"sessions.commands.create">["body"];

const sending = new Map<string, Promise<unknown>>();

// One at a time per Session, so a quick run of changes lands in the order made.
export async function command(
  sessionId: string,
  body: BrowserCommand,
): Promise<void> {
  const send = async () =>
    request("sessions.commands.create", { params: { id: sessionId }, body });

  const sent = (sending.get(sessionId) ?? Promise.resolve()).then(send, send);

  sending.set(sessionId, sent);

  try {
    await sent;
  } finally {
    if (sending.get(sessionId) === sent) {
      sending.delete(sessionId);
    }
  }
}
