import { expect, test } from "bun:test";
import { relayAddress, watchReach } from "./reach";

test("a relay never opens a loopback address, so a named host can't point at the machine itself", async () => {
  expect(await relayAddress("localhost")).toBeUndefined();
});

test("a host that resolves to the machine itself is reported as not reached", async () => {
  const controller = new AbortController();

  const reach = watchReach(
    [{ host: "localhost", port: 443 }],
    () => undefined,
    controller.signal,
  );

  await Bun.sleep(50);

  expect(reach()).toEqual([{ host: "localhost", port: 443, reached: false }]);

  controller.abort();
});
