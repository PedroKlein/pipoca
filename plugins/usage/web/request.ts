import { usage } from "../plugin";

// A fetch of the plugin's own routes, or of the server's for a path that
// starts with /, sending a body as JSON.
export async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(path.startsWith("/") ? path : `/api/ext/${usage.id}/${path}`, {
    ...init,
    headers,
  });
}
