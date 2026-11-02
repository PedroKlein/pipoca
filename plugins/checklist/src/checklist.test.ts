import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SessionCloud } from "@pipoca/plugins";
import { isOpen, type Item, listOf } from "./list";
import { checklist } from "./session";

function registeredTool(): ToolDefinition {
  const tools: ToolDefinition[] = [];

  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  void checklist.extension?.({} as SessionCloud)(pi);

  const [tool] = tools;
  if (tool === undefined) {
    throw new Error("checklist registered no tool");
  }

  return tool;
}

// A transcript line as Pi writes a tool's result.
async function resultLine(items: readonly Item[]): Promise<string> {
  const tool = registeredTool();

  const result = await tool.execute(
    "call-1",
    { items },
    undefined,
    undefined,
    {} as ExtensionToolContext,
  );

  return JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: tool.name,
      content: result.content,
      details: result.details,
      isError: false,
    },
  });
}

const steps: readonly Item[] = [
  { text: "Read the code", status: "completed" },
  { text: "Write the fix", status: "in_progress" },
  { text: "Run the tests", status: "pending" },
];

test("keeps the list an update_checklist call sends in its result", async () => {
  const line = await resultLine(steps);

  expect(line).toContain("Checklist updated: 1 of 3 done.");
  expect(listOf(line)).toEqual(steps);
});

test("an empty list clears the checklist", async () => {
  expect(listOf(await resultLine([]))).toEqual([]);
});

test("reads no list from other lines", () => {
  const otherTool = JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolName: "bash", details: { items: [] } },
  });

  const failed = JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "update_checklist",
      isError: true,
      details: {},
    },
  });

  expect(listOf(otherTool)).toBeUndefined();
  expect(listOf(failed)).toBeUndefined();
  expect(listOf("not json update_checklist")).toBeUndefined();
});

test("a list is open until every item is done", () => {
  expect(isOpen(steps)).toBe(true);
  expect(isOpen([])).toBe(false);

  expect(isOpen(steps.map((item) => ({ ...item, status: "completed" })))).toBe(
    false,
  );
});
