import { expect, test } from "bun:test";
import { isBusy } from "./index";

test("a Session is busy until it settles", () => {
  for (const busy of ["queued", "starting", "running"] as const) {
    expect(isBusy(busy)).toBe(true);
  }

  for (const settled of ["idle", "interrupted", "failed", "stopped"] as const) {
    expect(isBusy(settled)).toBe(false);
  }
});
