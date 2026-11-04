import { expect, test } from "bun:test";
import { healthFrom, modelRef, modelValue, storedAliases } from "./model";

test("keeps only the until, reason and a well-formed quota of reported health", () => {
  const capped = { until: "2026-10-22T00:00:00Z", reason: "402" };
  const limited = { until: "2026-10-21T20:31:00Z", reason: "429" };
  const quota = { spent: 10, cap: 10, currency: "USD" };

  expect(
    healthFrom({
      version: 1,
      unhealthyUntil: {
        capped: { ...capped, quota, note: "from a newer gateway" },
        limited: { ...limited, quota: 5 },
      },
    }),
  ).toEqual({
    version: 1,
    unhealthyUntil: { capped: { ...capped, quota }, limited },
  });
});

test("reads a config saved as backends and tiers as the same aliases with their own model lists", () => {
  expect(
    storedAliases({
      fallbackChain: ["copilot", "google"],
      defaultAlias: "medium-2",
      backends: {
        copilot: {
          tiers: {
            medium: ["gpt-5.3-codex", "claude-sonnet"],
            light: "gpt-mini",
          },
          capStatusCodes: [402, 403],
        },
        google: {
          tiers: { medium: "gemini-flash" },
          resetSchedule: "utc-midnight",
        },
        spare: { tiers: { medium: "big" }, forceOnly: true },
      },
    }),
  ).toEqual({
    models: {
      "medium-1": ["copilot/gpt-5.3-codex", "google/gemini-flash"],
      "medium-2": ["copilot/claude-sonnet", "google/gemini-flash"],
      "light-1": ["copilot/gpt-mini"],
    },
    providers: {
      copilot: { capStatusCodes: [402, 403] },
      google: { resetSchedule: "utc-midnight" },
    },
    defaultAlias: "medium-2",
  });
});

test("reads a trailing reasoning level, and leaves other colons in the id", () => {
  expect(
    ["openai/gpt-5:high", "ollama/qwen3:8b", "bedrock/claude-v2:1:max"].map(
      modelRef,
    ),
  ).toEqual([
    { provider: "openai", id: "gpt-5", thinking: "high" },
    { provider: "ollama", id: "qwen3:8b" },
    { provider: "bedrock", id: "claude-v2:1", thinking: "max" },
  ]);

  expect(modelValue({ provider: "openai", id: "gpt-5", thinking: "low" })).toBe(
    "openai/gpt-5:low",
  );
});
