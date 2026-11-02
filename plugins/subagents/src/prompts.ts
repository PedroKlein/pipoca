// Prompt shortcuts that tell the agent how to fan out with `subagent`
// (ADR 0057). They are plain prompt templates, by command name.
export const prompts: Readonly<Record<string, string>> = {
  "parallel-review": `---
description: Review the current work with parallel reviewers, each from its own angle
argument-hint: "[what to review]"
---
Review \${@:-the current changes} with parallel subagents.

Start 3 \`reviewer\` subagents in one \`subagent\` call with \`tasks\`, each with a distinct angle chosen for this work, such as correctness and regressions, tests and validation, and simplicity. Give each the exact files, diff or commits to review, since they don't see this conversation. Ask for concrete findings with file and line, what goes wrong, and a fix, or "No issues found."

When they finish, merge their findings into: fixes worth doing now, optional improvements, and findings to drop with a short reason. Don't edit files until I say so.`,

  "review-loop": `---
description: Implement, review and fix in a loop until the reviewers find nothing
argument-hint: "<what to build>"
---
Build $@ with a review loop.

1. Start a \`worker\` subagent with a complete brief: the goal, the files involved and the checks to run.
2. When it finishes, start 2 \`reviewer\` subagents in parallel on what it changed.
3. If they find real problems, start a \`worker\` to fix exactly those, then review again.
4. Stop when the reviewers find nothing worth fixing, or after 3 rounds, and report what changed and what's left.`,

  "parallel-research": `---
description: Research a question in parallel, in the codebase and from the scouts' findings
argument-hint: "<question>"
---
Research: $@

Start 2 or 3 \`scout\` subagents in one \`subagent\` call with \`tasks\`, each on a different part of the question, such as where it lives in the code, how it's used, and what constrains a change. Then combine what they found into one answer with file references and the trade-offs that matter.`,

  "gather-context-and-clarify": `---
description: Gather context with a scout, then ask only the questions that matter
argument-hint: "<task>"
---
Before starting on $@, gather context and then ask me what you can't find out yourself.

Start a \`scout\` subagent to find the relevant code, conventions and constraints. When it finishes, ask me only the questions whose answers would change what you build, each with your recommended answer. Don't start the work yet.`,
};
