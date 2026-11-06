import { previewPort } from "@pipoca/protocol";

// A page on the Session's own machine opens through a preview (ADR 0037).
export function pageLink(sessionId: string, url: string): string {
  const port = previewPort(url);
  if (port === undefined) {
    return url;
  }

  const { pathname, search, hash } = new URL(url);
  const path = encodeURIComponent(`${pathname}${search}${hash}`);

  return `/api/sessions/${encodeURIComponent(sessionId)}/previews/${String(port)}?path=${path}`;
}
