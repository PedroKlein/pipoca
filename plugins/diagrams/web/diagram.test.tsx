import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import { web } from "./index";

const code = "graph LR\n  a --> b\n";

test("shows a diagram the agent is still writing as code", () => {
  const page = renderPart(web, "codeBlock:mermaid", { code, complete: false });

  expect(page.querySelector("pre")?.textContent).toBe(code);
  expect(page.textContent).not.toContain("Drawing");
});

test("says it is drawing a finished diagram until Mermaid is ready", () => {
  const page = renderPart(web, "codeBlock:mermaid", { code, complete: true });

  expect(page.querySelector("pre")?.textContent).toBe(code);
  expect(page.textContent).toContain("Drawing the diagram…");
});
