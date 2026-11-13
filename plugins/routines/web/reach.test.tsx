import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import { web } from "./index";
import { ReachWarning } from "./reach";

Object.assign(globalThis, {
  EventSource: class {
    addEventListener(): void {
      // Nothing changes.
    }

    close(): void {
      // Nothing to close.
    }
  },
});

const environment = (id: string, reached: boolean) => ({
  id,
  name: id,
  reaches: reached
    ? [{ host: "github.acme.internal", port: 443, reached: true }]
    : [],
});

// The warning, drawn as a slot.
const slots = { step: ReachWarning };

function warning(chosen: string) {
  const used: string[] = [];

  const page = renderPart(
    { ...web, slots },
    "step",
    {
      repository: "https://github.acme.internal/acme/payments",
      environment: chosen,
      team: false,
      onUse: (id: string) => {
        used.push(id);
      },
    },
    {
      fetch: async (url) =>
        Promise.resolve(
          Response.json(
            url.endsWith("private-hosts")
              ? { hosts: [{ host: "github.acme.internal" }] }
              : [environment("pods", false), environment("faraday", true)],
          ),
        ),
    },
  );

  return { page, used };
}

const settle = async (): Promise<void> => {
  await act(async () => until(async () => Promise.resolve(true)));
};

test("a routine that clones from a private host warns when its Environment can't reach it, and offers one that can", async () => {
  const { page, used } = warning("pods");

  await until(async () => {
    await settle();

    return page.textContent.includes("pods can't reach github.acme.internal");
  });

  expect(page.textContent).toContain(
    "Runs need an Environment of yours that reaches it.",
  );

  await act(async () => {
    page.querySelector("button")?.click();
    await Promise.resolve();
  });

  expect(used).toEqual(["faraday"]);
});

test("a routine on an Environment that reaches its private host shows no warning", async () => {
  const { page } = warning("faraday");

  for (let look = 0; look < 5; look++) {
    await settle();
  }

  expect(page.textContent).toBe("");
});
