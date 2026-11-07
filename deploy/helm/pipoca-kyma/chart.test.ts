import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const values = readFileSync(join(import.meta.dir, "values.yaml"), "utf8");

const pipoca = /^pipoca:\n((?: {2}.*\n|\s*\n)+)/m.exec(values)?.[1] ?? "";

// The APIRule's policy for runners matches only mesh peers, so runner pods
// join the mesh along with the server, in any namespace.
test("the Kyma chart puts the server and runner pods in the mesh", () => {
  expect(pipoca).toMatch(
    /^ {2}podLabels:\n {4}sidecar\.istio\.io\/inject: "true"$/m,
  );

  expect(pipoca).toMatch(
    /^ {2}runnerPods:\n(?: {4}.*\n)*? {4}labels:\n {6}sidecar\.istio\.io\/inject: "true"$/m,
  );
});

// Behind the gateway every request comes from it, so failed sign-ins count
// by the client address it forwards.
test("the Kyma chart trusts the gateway in front", () => {
  expect(pipoca).toMatch(/^ {2}trustProxy: true$/m);
});

// The plain chart names its resources after the release, so a release
// upgraded from it to this chart keeps its volume and secret key.
test("the Kyma chart takes the plain chart as it is", () => {
  const chart = readFileSync(join(import.meta.dir, "Chart.yaml"), "utf8");

  const plain = readFileSync(
    join(import.meta.dir, "../pipoca/Chart.yaml"),
    "utf8",
  );

  const version = /^version: (.+)$/m.exec(plain)?.[1] ?? "";

  expect(chart).toContain(
    `  - name: pipoca\n    version: ${version}\n    repository: file://../pipoca\n`,
  );
});
