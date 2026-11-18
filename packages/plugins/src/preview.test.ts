import { expect, test } from "bun:test";
import { preview } from "./preview";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("a CSV draws as a table that reads quotes, commas and newlines", async () => {
  const shown = preview(
    "p95.csv",
    bytes('a,b\n"x, y","say ""hi""\nthere"\r\n1,<2>\n'),
  );

  expect(shown?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(shown?.headers.get("content-security-policy")).toStartWith("sandbox");

  expect(await shown?.text()).toContain(
    '<table class="sheet"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x, y</td><td>say &quot;hi&quot;\nthere</td></tr><tr><td>1</td><td>&lt;2&gt;</td></tr></tbody></table>',
  );
});

test("code and other text show as their escaped source, also any file asked to", async () => {
  expect(await preview("run.py", bytes("print('<b>')"))?.text()).toContain(
    "<pre>print('&lt;b&gt;')</pre>",
  );

  expect(
    await preview("p95.csv", bytes("a,b"), { kind: "text" }).text(),
  ).toContain("<pre>a,b</pre>");
});

test("pictures and PDFs go as they are, and a file it can't draw has no preview", async () => {
  const picture = preview("chart.png", bytes("png"));

  expect(picture?.headers.get("content-type")).toBe("image/png");
  expect(await picture?.text()).toBe("png");

  expect(
    preview("doc.pdf", bytes("%PDF"))?.headers.has("content-security-policy"),
  ).toBe(false);

  expect(preview("book.xlsx", bytes("x"))).toBeUndefined();
  expect(preview("README", bytes("x"))).toBeUndefined();
});

test("a script given runs in every page it draws", async () => {
  const script = "<script>told()</script>";

  expect(
    await preview("a.html", bytes("<p>hi</p></body>"), { script })?.text(),
  ).toBe("<p>hi</p><script>told()</script></body>");

  expect(await preview("a.md", bytes("# Hi"), { script })?.text()).toContain(
    "<h1>Hi</h1>\n<script>told()</script></body>",
  );
});
