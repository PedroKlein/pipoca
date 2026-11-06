import type { Session } from "@pipoca/protocol";
import { useEffect, useRef } from "react";
import { noticeText, settled } from "../notices";
import { href, navigate } from "../router";

// Tells the browser when a session stops working, unless it is on screen or
// the browser gets push notifications for it instead.
export function useSettledNotices(
  sessions: readonly Session[],
  opened: string,
): void {
  const previous = useRef<readonly Session[]>([]);

  useEffect(() => {
    const done = settled(previous.current, sessions);
    previous.current = sessions;

    if (
      done.length === 0 ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }

    void pushed().then((subscribed) => {
      if (!subscribed) {
        notify(done, opened);
      }
    });
  }, [sessions, opened]);

  // A clicked push notification asks an open window to show its Session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const open = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; session?: unknown };
      if (data.type === "open-session" && typeof data.session === "string") {
        navigate(href("session", { id: data.session }));
      }
    };

    navigator.serviceWorker.addEventListener("message", open);

    return () => {
      navigator.serviceWorker.removeEventListener("message", open);
    };
  }, []);
}

async function pushed(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    return false;
  }

  const registration = await navigator.serviceWorker.getRegistration("/");

  const subscription = await registration?.pushManager.getSubscription();

  return subscription !== undefined && subscription !== null;
}

function notify(done: readonly Session[], opened: string): void {
  for (const session of done) {
    if (session.id === opened && document.visibilityState === "visible") {
      continue;
    }

    let notice: Notification;

    // Android Chrome grants permission but throws here: it only allows
    // notifications from a service worker.
    try {
      notice = new Notification(noticeText(session), { tag: session.id });
    } catch {
      return;
    }

    notice.addEventListener("click", () => {
      window.focus();
      navigate(href("session", { id: session.id }));
      notice.close();
    });
  }
}
