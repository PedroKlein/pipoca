import { expect, test } from "bun:test";
import type { Urls } from "@pipoca/plugins";
import { appManifest } from "./technical-users";

// GitHub refuses a manifest whose default events need a permission it
// doesn't ask for.
const eventPermissions: Readonly<Record<string, string>> = {
  check_run: "checks",
  create: "contents",
  delete: "contents",
  deployment: "deployments",
  issue_comment: "issues",
  issues: "issues",
  pull_request: "pull_requests",
  pull_request_review: "pull_requests",
  pull_request_review_comment: "pull_requests",
  push: "contents",
  release: "contents",
};

const urls = {
  public: (path: string) => `https://pipoca.example/api/ext/git-hosts/${path}`,
} as Urls;

test("asks for a permission behind every webhook event in the App manifest", () => {
  const manifest = appManifest("Pipoca bot", urls, "h00k");
  const events = manifest["default_events"] as readonly string[];
  const permissions = manifest["default_permissions"] as Record<string, string>;

  expect(events.length).toBeGreaterThan(0);

  expect(
    events.filter((event) => {
      const needed = eventPermissions[event];

      return needed === undefined || permissions[needed] === undefined;
    }),
  ).toEqual([]);
});
