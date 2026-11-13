import { expect, test } from "bun:test";
import { hostPortOf, privateHostOf, repositoryHost } from "./index";

test("a private host is an exact name with an optional port", () => {
  expect(hostPortOf("GitHub.Acme.Internal")).toEqual({
    host: "github.acme.internal",
    port: 443,
  });

  expect(hostPortOf("jira.acme.internal:8443")).toEqual({
    host: "jira.acme.internal",
    port: 8443,
  });

  for (const refused of [
    "*.acme.internal",
    "10.0.0.5",
    "localhost",
    "db.localhost",
    "acme",
    "https://github.acme.internal",
    "github.acme.internal:0",
    "github.acme.internal:70000",
  ]) {
    expect(hostPortOf(refused)).toBeUndefined();
  }
});

test("a repository's host comes from https, ssh and scp-like URLs", () => {
  expect(repositoryHost("https://github.acme.internal/acme/app.git")).toBe(
    "github.acme.internal",
  );

  expect(repositoryHost("ssh://git@github.acme.internal/acme/app")).toBe(
    "github.acme.internal",
  );

  expect(repositoryHost("git@GitHub.acme.internal:acme/app.git")).toBe(
    "github.acme.internal",
  );

  expect(repositoryHost("/home/ana/app")).toBeUndefined();
});

test("a repository lives on a private host listed with or without a port", () => {
  const hosts = [{ host: "github.acme.internal:8443" }];

  expect(
    privateHostOf("https://github.acme.internal/acme/payments", hosts),
  ).toBe("github.acme.internal");

  expect(privateHostOf("git@github.com:acme/payments.git", hosts)).toBe(
    undefined,
  );
});
