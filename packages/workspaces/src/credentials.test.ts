import { expect, test } from "bun:test";
import { ghConfig, withoutGitTokens } from "./credentials";

test("gives gh the hosts other than github.com, which it reads from GH_TOKEN", () => {
  expect(
    ghConfig([
      { host: "github.com", token: "own-token" },
      { host: "github.tools.sap", token: "sap-token" },
    ]),
  ).toEqual({
    "config.yml": 'version: "1"\n',
    "hosts.yml":
      '"github.tools.sap":\n  oauth_token: "sap-token"\n  git_protocol: https\n',
  });

  expect(
    ghConfig([{ host: "github.com", token: "own-token" }]),
  ).toBeUndefined();
});

test("leaves out the git hosts' tokens and the machine's credential helpers", () => {
  expect(
    withoutGitTokens({
      GH_TOKEN: "own-token",
      GITLAB_TOKEN: "lab-token",
      EDITOR: "vim",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: "cat",
    }),
  ).toEqual({
    EDITOR: "vim",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "cat",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  });
});
