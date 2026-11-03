// What Slack answered, in words for an admin or a Session.
export class SlackRefused extends Error {}

const timeoutMs = 15_000;

// One Web API method, which answers ok: false instead of an HTTP error.
export async function call(
  api: string,
  token: string,
  method: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  let response: Response;

  try {
    response = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (failure) {
    throw new SlackRefused(
      `couldn't reach Slack: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }

  const answer = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (answer["ok"] !== true) {
    const error = answer["error"];

    throw new SlackRefused(
      `Slack refused ${method}: ${typeof error === "string" ? error : `HTTP ${String(response.status)}`}`,
    );
  }

  return answer;
}

// Who a bot token posts as.
export async function botOf(
  api: string,
  token: string,
): Promise<{ readonly team: string; readonly userId: string }> {
  const answer = await call(api, token, "auth.test");
  const { team, user_id: userId } = answer;

  if (typeof team !== "string" || typeof userId !== "string") {
    throw new SlackRefused("Slack didn't say who the bot token belongs to");
  }

  return { team, userId };
}
