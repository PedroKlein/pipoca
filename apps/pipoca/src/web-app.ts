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

export function webAppFile(pathname: string): Response | undefined {
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
