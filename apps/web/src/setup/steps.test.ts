import { expect, test } from "bun:test";
import type { SetupStep, WebPart } from "@pipoca/plugins/web";
import { serverSteps } from "./steps";

const part = (id: string, after: SetupStep["after"]): WebPart =>
  ({
    plugin: { id },
    setup: [
      {
        audience: "server",
        after,
        title: id,
        summary: "",
        heading: id,
        description: "",
        done: async () => Promise.resolve(true),
        Step: () => null,
      },
    ],
  }) as unknown as WebPart;

const order = (parts: readonly WebPart[]): readonly string[] =>
  serverSteps({ solo: false, install: false, parts }).map(({ id }) => id);

test("puts a step right after another plugin's, and after its kernel step when that plugin is off", () => {
  const codeHosts = part("git-hosts", { plugin: "oidc", or: "plugins" });
  const signIn = part("oidc", "plugins");
  const keys = part("logins", "default-profile");

  expect(order([codeHosts, keys, signIn])).toEqual([
    "who",
    "plugins",
    "oidc",
    "git-hosts",
    "default-profile",
    "logins",
    "where",
    "newcomers",
  ]);

  expect(order([codeHosts, keys])).toEqual([
    "who",
    "plugins",
    "git-hosts",
    "default-profile",
    "logins",
    "where",
    "newcomers",
  ]);
});

test("follows only a plugin step that goes after a kernel step, so steps naming each other both show", () => {
  const one = part("one", { plugin: "two", or: "where" });
  const two = part("two", { plugin: "one", or: "plugins" });

  expect(order([one, two])).toEqual([
    "who",
    "plugins",
    "two",
    "default-profile",
    "where",
    "one",
    "newcomers",
  ]);
});
