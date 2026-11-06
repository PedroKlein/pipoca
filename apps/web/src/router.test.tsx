import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { href, navigate, parse, routeHref, scopedHref, useRoute } =
  await import("./router");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("an address opens its page with the parts it names", () => {
  expect(parse("")).toEqual({ name: "home", params: {} });

  expect(parse("#settings")).toEqual({
    name: "settings",
    params: { page: "", rest: "" },
  });

  expect(parse("#settings/profiles/p1/files")).toEqual({
    name: "settings",
    params: { page: "profiles", rest: "p1/files" },
  });

  expect(parse("team/")).toEqual({ name: "team", params: {} });

  expect(parse("team/sessions/s1")).toEqual({
    name: "teamSession",
    params: { id: "s1" },
  });

  expect(parse("team/setup")).toEqual({
    name: "teamSetup",
    params: { section: "", rest: "" },
  });

  expect(parse("team/setup/plugin/logins/credentials")).toEqual({
    name: "teamSetup",
    params: { section: "plugin", rest: "logins/credentials" },
  });

  expect(parse("plugin/projects")).toEqual({
    name: "plugin",
    params: { name: "projects", path: "" },
  });

  expect(parse("plugin/projects/p1/t1")).toEqual({
    name: "plugin",
    params: { name: "projects", path: "p1/t1" },
  });

  expect(parse("get-started/model")).toEqual({
    name: "getStarted",
    params: { step: "model" },
  });

  expect(parse("abc-123")).toEqual({
    name: "session",
    params: { id: "abc-123" },
  });
});

test("an address no page has opens home", () => {
  expect(parse("nothing/here")).toEqual({ name: "home", params: {} });
});

test("links are built from a page and its parts", () => {
  expect(href("home")).toBe("#");
  expect(href("settings")).toBe("#settings");

  expect(href("settings", { page: "environments", rest: "e1" })).toBe(
    "#settings/environments/e1",
  );

  expect(href("teamSession", { id: "s1" })).toBe("#team/sessions/s1");
  expect(href("plugin", { name: "routines" })).toBe("#plugin/routines");
  expect(href("session", { id: "s1" })).toBe("#s1");
});

test("a link and its address open the same page", () => {
  const link = href("teamPlugin", { plugin: "usage", key: "costs" });

  expect(parse(link)).toEqual({
    name: "teamPlugin",
    params: { plugin: "usage", key: "costs" },
  });

  expect(routeHref(parse(link))).toBe(link);
  expect(routeHref(parse("team/"))).toBe("#team");
});

test("environments and profiles are a person's or the team's", () => {
  expect(scopedHref(false, "profiles", "p1")).toBe("#settings/profiles/p1");

  expect(scopedHref(true, "environments")).toBe("#team/setup/environments");
});

function Current(): ReactElement {
  const route = useRoute();

  return <p id="route">{route.name}</p>;
}

test("useRoute follows the address", async () => {
  location.hash = "";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(<Current />);
  });

  expect(container.textContent).toBe("home");

  await act(async () => {
    navigate(href("settings", { page: "tokens" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(container.textContent).toBe("settings");

  act(() => {
    root.unmount();
  });
});
