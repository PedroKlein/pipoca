// Rejects with the server's error message when the response isn't ok, with
// its code as the cause (ADR 0047).
export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await ok(response)).json()) as T;
}

// Like json, for responses without a body.
export async function ok(response: Promise<Response>): Promise<Response> {
  const settled = await response;

  if (!settled.ok) {
    const { error, message } = (await settled.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };

    const code = typeof error === "string" ? error : undefined;

    throw new Error(
      typeof message === "string"
        ? message
        : (code ?? `${String(settled.status)} ${settled.statusText}`),
      { cause: code },
    );
  }

  return settled;
}
