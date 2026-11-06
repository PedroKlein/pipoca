import { describe, expect, test } from "bun:test";
import { FileButton } from "./file-button";
import { render, withPage } from "./testing/render";

withPage();

describe("FileButton", () => {
  test("keeps a labelled file input inside the button", () => {
    const container = render(
      <FileButton
        iconOnly
        icon="paperclip"
        aria-label="Attach images"
        multiple
        onFiles={() => undefined}
      />,
    );

    const input = container.querySelector("input");

    expect(input?.type).toBe("file");
    expect(input?.multiple).toBe(true);
    expect(input?.getAttribute("aria-label")).toBe("Attach images");
  });
});
