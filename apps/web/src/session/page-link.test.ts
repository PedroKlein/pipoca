import { expect, test } from "bun:test";
import { pageLink } from "./page-link";

test("a page on the Session's machine opens through its preview", () => {
  expect(pageLink("s 1", "http://localhost:5173/review?id=2#top")).toBe(
    "/api/sessions/s%201/previews/5173?path=%2Freview%3Fid%3D2%23top",
  );

  expect(pageLink("s1", "http://127.0.0.1/")).toBe(
    "/api/sessions/s1/previews/80?path=%2F",
  );
});

test("any other page opens as it is", () => {
  expect(pageLink("s1", "https://example.com/a")).toBe("https://example.com/a");
});
