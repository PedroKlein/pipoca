import { apiClient, type ApiInput } from "@pipoca/protocol";

// The server's routes, typed by the route table (ADR 0068).
export const api = apiClient();

// What a browser sends a Session; the server adds the actor.
export type BrowserCommand = ApiInput<"sessions.commands.create">["body"];

const sending = new Map<string, Promise<unknown>>();

// One at a time per Session, so a quick run of changes lands in the order made.
export async function command(
  sessionId: string,
  body: BrowserCommand,
): Promise<void> {
  const send = async () =>
    api("sessions.commands.create", { params: { id: sessionId }, body });

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
