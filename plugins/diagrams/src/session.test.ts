import { expect, test } from "bun:test";
import { testSession } from "@pipoca/testing";
import { session } from "./session";

test("tells the agent to draw with Mermaid on every run", async () => {
  const part = await testSession(session);

  const run = async (): Promise<string[]> => {
    const promptGuidelines = ["Be brief."];

    await part.event("before_agent_start", {
      systemPromptOptions: { promptGuidelines },
    });

    return promptGuidelines;
  };

  for (const prompt of [await run(), await run()]) {
    expect(prompt).toHaveLength(2);
    expect(prompt[1]).toContain("```mermaid");
  }
});
