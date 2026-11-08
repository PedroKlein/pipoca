import { expect, test } from "bun:test";
import {
  agentText,
  newAgent,
  parseAgent,
  startedAgents,
  workflowAbout,
} from "./agent-files";

test("reads an agent's frontmatter and prompt", () => {
  const agent = parseAgent(
    "agents/fixer.md",
    `---
description: "Fixes bugs: small ones"
model: anthropic/opus
thinking: high
tools: read, bash, mcp__jira__*
mcp:
  - jira
skills: [review, "go"]
color: red
---

Fix the bug.
`,
  );

  expect(agent).toEqual({
    path: "agents/fixer.md",
    name: "fixer",
    description: "Fixes bugs: small ones",
    model: "anthropic/opus",
    thinking: "high",
    tools: ["read", "bash", "mcp__jira__*"],
    mcp: ["jira"],
    skills: ["review", "go"],
    prompt: "Fix the bug.",
    rest: ["color: red"],
  });
});

test("writes an agent so it reads back the same", () => {
  const agent = {
    ...newAgent("fixer"),
    description: "Fixes bugs: small ones",
    thinking: "low" as const,
    tools: ["read", "mcp__jira__search"],
    mcp: ["jira"],
    skills: ["review"],
    prompt: "Fix the bug.",
    rest: ["color: red"],
  };

  const text = agentText(agent);

  expect(text).toBe(`---
name: fixer
description: "Fixes bugs: small ones"
thinking: low
tools: read, mcp__jira__search
mcp: jira
skills: review
color: red
---

Fix the bug.
`);

  expect(parseAgent("agents/fixer.md", text)).toEqual(agent);
});

test("an agent file without frontmatter is all prompt", () => {
  const agent = parseAgent("agents/plain.md", "Just do it.");

  expect(agent.name).toBe("plain");
  expect(agent.tools).toEqual([]);
  expect(agent.prompt).toBe("Just do it.");
});

test("finds the agents a workflow starts and what it does", () => {
  const script = `// Reviews until clean.
const plan = await runs.run({ agent: "planner", task: args.task });
for (let round = 0; round < 3; round += 1) {
  await runs.run({ key: \`fix-\${round}\`, agent: 'worker', task: plan });
  await runs.run({ agent: "reviewer", task: plan });
}
await runs.run({ agent: "worker", task: "wrap up" });
`;

  expect(startedAgents(script)).toEqual(["planner", "worker", "reviewer"]);
  expect(workflowAbout(script)).toBe("Reviews until clean.");
});
