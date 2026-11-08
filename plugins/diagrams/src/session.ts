import { defineSession } from "@pipoca/plugins";
import { diagrams } from "../plugin";

const rule =
  "When a picture explains better than prose, such as a flow, a sequence of calls, states, or how parts connect, add a small Mermaid diagram in a ```mermaid fenced block. The user's chat draws it. Keep it to about 15 nodes, and skip it for simple answers.";

// Pi builds the prompt afresh for every run, so the rule is added each time.
export const session = defineSession(diagrams, (s) => {
  s.extension((pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.promptGuidelines.push(rule);
    });
  });
});
