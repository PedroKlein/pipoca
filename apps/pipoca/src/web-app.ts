import { appIcons } from "./app-icons" with { type: "macro" };

const icons = appIcons();

// What a browser needs to install the web UI as an app, with its own window
// and dock icon (ADR 0053). Browsers fetch these without the sign-in cookie.
const manifest = {
  name: "Pipoca",
  short_name: "Pipoca",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#1A1712",
  theme_color: "#1A1712",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    {
      src: "/maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

// Shows the notifications a push plugin sends, unless the person is looking
// at that Session, and opens the Session when one is clicked. It is served
// from the root so its scope covers the whole app.
const serviceWorker = `
const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const notice = event.data ? event.data.json() : {};

  event.waitUntil((async () => {
    const watching = (await windows()).some(
      (client) => client.focused && new URL(client.url).hash === "#" + notice.session,
    );

    if (!watching) {
      await self.registration.showNotification(notice.title ?? "Pipoca", {
        body: notice.body,
        tag: notice.session,
        data: { session: notice.session, url: notice.url ?? "/" },
      });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { session, url } = event.notification.data ?? {};

  event.waitUntil((async () => {
    const [open] = await windows();

    if (open === undefined) {
      await self.clients.openWindow(url ?? "/");
      return;
    }

    open.postMessage({ type: "open-session", session });
    await open.focus();
  })());
});
`;

export function webAppFile(pathname: string): Response | undefined {
  if (pathname === "/sw.js") {
    return new Response(serviceWorker, {
      headers: {
        "content-type": "text/javascript",
        "cache-control": "no-cache",
      },
    });
  }

  if (pathname === "/manifest.webmanifest") {
    return Response.json(manifest, {
      headers: { "content-type": "application/manifest+json" },
    });
  }

  const icon = icons[pathname.slice(1)];
  if (icon === undefined) {
    return undefined;
  }

  return new Response(Buffer.from(icon, "base64"), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
}
