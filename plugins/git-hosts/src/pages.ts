import { createHash } from "node:crypto";

// Where the browser reached the server. The Host header already passed the
// server's own site check.
export function originOf(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  return `${secure(request) ? "https" : "http"}://${host}`;
}

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
export function secure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

// A page that moves on by itself instead of a 302: the browser came here from
// the host's site, and would leave the Strict session cookie off a redirect
// it follows straight away.
export function redirect(to: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Pipoca</title><a href="${to}">Continue</a>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/#settings/git-hosts">Back to Pipoca</a></p>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
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
