import { expect, test } from "bun:test";
import { testSession, until } from "@pipoca/testing";
import { noHealth } from "./model";
import { session } from "./session";

// A server that answers every config read at once, the same each time or
// failing, counting the reads.
async function follower(answer: () => Response) {
  const reads: number[] = [];

  await testSession(session, {
    request: async () => {
      reads.push(Date.now());

      return reads.length > 3
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(answer());
    },
  });

  return until(
    () => reads,
    (all) => all.length > 3,
  );
}

test.each([
  [
    "an unchanged answer",
    () => Response.json({ version: 1, aliases: null, health: noHealth }),
  ],
  ["an error", () => Response.json({ message: "down" }, { status: 500 })],
])("waits about a second before asking again after %s", async (_, answer) => {
  const reads = await follower(answer);
  const gaps = reads.slice(2).map((at, index) => at - (reads[index + 1] ?? 0));

  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(900);
  }
});
