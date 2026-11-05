import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { transcriptReader } from "@pipoca/plugins/host";

const lines = readFileSync(
  new URL("testdata/pi-session.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line !== "");

const transcript = transcriptReader((id) => (id === "s1" ? lines : []));

test("reads a tool's results with the input of each call", () => {
  expect(transcript.toolResults("s1", "read")).toEqual([
    {
      callId: "tool:1793892548191:bxajzlngrkp",
      line: 6,
      input: { path: "notes.txt" },
      details: undefined,
      isError: false,
    },
    {
      callId: "tool:1793892548191:fkbqujjmwvu",
      line: 8,
      input: { path: "missing.txt" },
      details: {},
      isError: true,
    },
  ]);

  expect(transcript.toolResults("s1", "edit")).toEqual([
    {
      callId: "tool:1793892548191:psusq7j8yb",
      line: 12,
      input: {
        path: "notes.txt",
        edits: [{ oldText: "first line", newText: "second" }],
      },
      details: {
        diff: "-1 first line\n+1 second",
        patch:
          "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-first line\n+second\n",
        firstChangedLine: 1,
      },
      isError: false,
    },
  ]);
});

test("reads the chat, its last reply and its length", () => {
  expect(transcript.messages("s1", { sinceLine: 9 })).toEqual([
    { line: 9, role: "assistant", text: "The file says first line." },
    { line: 10, role: "user", text: "Now write second." },
    { line: 13, role: "assistant", text: "Done." },
  ]);

  expect(transcript.lastReply("s1")).toEqual({ line: 13, text: "Done." });
  expect(transcript.length("s1")).toBe(14);
});

test("reads nothing from a line cut short or a Session without lines", () => {
  const cut = transcriptReader(() => [
    lines[4] ?? "",
    (lines[5] ?? "").slice(0, 40),
  ]);

  expect(cut.messages("s1")).toEqual([
    { line: 0, role: "user", text: "What does notes.txt say?" },
  ]);

  expect(transcript.toolResults("s2", "read")).toEqual([]);
  expect(transcript.lastReply("s2")).toBeUndefined();
});
