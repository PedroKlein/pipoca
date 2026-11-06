import type { Urls } from "@pipoca/plugins";
import { type AuthorizationResponse, responseOf } from "./mcp";

// As long as a sign-in may run.
const signInMs = 10 * 60_000;

interface Callbacks {
  // Marks the browser the answer that starts a sign-in goes to, so only it
  // can finish it.
  readonly mark: (response: Response) => string;
  // Waits for the sign-in page to send the marked browser back with state.
  readonly wait: (
    browser: string,
  ) => (state: string, signal: AbortSignal) => Promise<AuthorizationResponse>;
  // Where the sign-in page sends the browser, signed in to Pipoca or not:
  // the session cookie stays off a navigation from another site.
  readonly handle: (request: Request) => Response;
}

interface Waiting {
  readonly browser: string;
  readonly resolve: (response: AuthorizationResponse) => void;
  readonly reject: (error: Error) => void;
}

export function callbacks(urls: Urls): Callbacks {
  const waiting = new Map<string, Waiting>();

  return {
    mark: (response) => urls.browser.mark(response, signInMs),
    wait: (browser) => async (state, signal) =>
      new Promise((resolve, reject) => {
        const forget = (): void => {
          waiting.delete(state);
          reject(new Error("Login cancelled"));
        };

        signal.addEventListener("abort", forget, { once: true });

        waiting.set(state, {
          browser,
          resolve: (response) => {
            signal.removeEventListener("abort", forget);
            resolve(response);
          },
          reject: (error) => {
            signal.removeEventListener("abort", forget);
            reject(error);
          },
        });
      }),
    handle: (request) => {
      const state = new URL(request.url).searchParams.get("state") ?? "";
      const waiter = waiting.get(state);

      if (waiter === undefined || !urls.browser.is(request, waiter.browser)) {
        return page(
          "This sign-in has expired. Start it again from Settings.",
          400,
        );
      }

      waiting.delete(state);

      try {
        waiter.resolve(responseOf(request.url, state));
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));

        waiter.reject(failure);

        return page(failure.message, 403);
      }

      return page("Signed in. You can close this tab.", 200);
    },
  };
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/#settings/accounts">Back to Pipoca</a></p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
