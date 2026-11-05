import { apiClient, type ApiInput } from "@pipoca/protocol";

// The server's routes, typed by the route table (ADR 0068).
export const api = apiClient();

// What a browser sends a Session; the server adds the actor.
export type BrowserCommand = ApiInput<"sessions.commands.create">["body"];

export async function command(
  sessionId: string,
  body: BrowserCommand,
): Promise<void> {
  await api("sessions.commands.create", { params: { id: sessionId }, body });
}
