import { type Static, Type } from "@pipoca/plugins";

// A page that moves on by itself instead of a 302: the browser came here from
// the host's site, and would leave the Strict session cookie off a redirect
// it follows straight away.
export function redirect(to: string): Response {
  return html(
    `<meta http-equiv="refresh" content="0;url=${to}"><title>Pipoca</title><a href="${to}">Continue</a>`,
    200,
  );
}

export function page(message: string, status: number): Response {
  return html(
    `<title>Pipoca</title><p>${escaped(message)}</p><p><a href="/#settings/git-hosts">Back to Pipoca</a></p>`,
    status,
  );
}

export function html(body: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// A flow started from a setup step goes back to that step (ADR 0072).
export const then = Type.Optional(
  Type.Union([Type.Literal("setup"), Type.Literal("server-setup")]),
);

export type Then = Static<typeof then> | undefined;

export function backTo(step: Then, otherwise: string): string {
  switch (step) {
    case "setup":
      return "/#get-started/git-hosts";
    case "server-setup":
      return "/#get-started/server:git-hosts";
    case undefined:
      return otherwise;
  }
}

export function escaped(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => `&#${String(character.charCodeAt(0))};`,
  );
}
