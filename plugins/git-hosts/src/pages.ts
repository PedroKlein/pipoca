import { createHash } from "node:crypto";

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

export function escaped(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => `&#${String(character.charCodeAt(0))};`,
  );
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
