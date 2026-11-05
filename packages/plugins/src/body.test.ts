import { expect, test } from "bun:test";
import { BadRequest, checkBody, readBody, Type } from "@pipoca/plugins";

const post = (body: string): Request =>
  new Request("http://plugin/items", { method: "POST", body });

const item = Type.Object({
  name: Type.String(),
  size: Type.Optional(Type.Number()),
  owner: Type.Optional(Type.Object({ id: Type.String() })),
});

const refusal = async (body: string): Promise<unknown> =>
  readBody(post(body), item).catch((error: unknown) => error);

test("reads a body that fits its schema", async () => {
  const body = await readBody(post('{"name":"a","size":2}'), item);

  expect(body).toEqual({ name: "a", size: 2 });
  expect(body.name.toUpperCase()).toBe("A");
});

test("refuses a body that doesn't fit, naming the field", async () => {
  expect(await refusal('{"size":2}')).toMatchObject({
    status: 422,
    code: "invalid",
    message: "body must have required properties name",
    details: { field: "" },
  });

  expect(await refusal('{"name":7}')).toMatchObject({
    status: 422,
    message: "name must be string",
    details: { field: "name" },
  });

  expect(await refusal('{"name":"a","owner":{"id":1}}')).toMatchObject({
    status: 422,
    message: "owner.id must be string",
    details: { field: "owner.id" },
  });

  expect(await refusal("[]")).toMatchObject({
    status: 422,
    message: "body must be object",
  });
});

test("leaves out fields the schema doesn't name", async () => {
  expect(await readBody(post('{"name":"a","admin":true}'), item)).toEqual({
    name: "a",
  });
});

const shape = Type.Object({
  shape: Type.Union([
    Type.Object({ kind: Type.Literal("circle"), radius: Type.Number() }),
    Type.Object({ kind: Type.Literal("square"), side: Type.Number() }),
  ]),
  size: Type.Optional(Type.Enum(["small", "large"])),
});

const shapeRefusal = async (body: unknown): Promise<unknown> =>
  readBody(post(JSON.stringify(body)), shape).catch((error: unknown) => error);

test("names what is wrong with the shape a body picks", async () => {
  expect(
    await shapeRefusal({ shape: { kind: "square", radius: 1 } }),
  ).toMatchObject({ message: "shape must have required properties side" });

  expect(
    await shapeRefusal({ shape: { kind: "square", side: "1" } }),
  ).toMatchObject({ message: "shape.side must be number" });

  expect(await shapeRefusal({ shape: { kind: "star" } })).toMatchObject({
    message: "shape.kind must be one of circle, square",
    details: { field: "shape.kind" },
  });

  expect(await shapeRefusal({ shape: {} })).toMatchObject({
    message: "shape must have required properties kind",
  });

  expect(
    await shapeRefusal({ shape: { kind: "circle", radius: 1 }, size: "huge" }),
  ).toMatchObject({ message: "size must be one of small, large" });
});

test("refuses a body to check that isn't JSON", async () => {
  const refused = await refusal("{not json");

  expect(refused).toBeInstanceOf(BadRequest);
  expect(refused).toMatchObject({ status: 400, message: "body must be JSON" });
});

test("names the field of the untagged shape a body comes closest to", () => {
  const strict = { additionalProperties: false };

  const made = Type.Union([
    Type.Object({ name: Type.Optional(Type.String()) }, strict),
    Type.Object(
      { from: Type.String(), summary: Type.String({ minLength: 2 }) },
      strict,
    ),
  ]);

  const refused = (() => {
    try {
      return checkBody({ from: "a", summary: " " }, made);
    } catch (error) {
      return error;
    }
  })();

  expect(refused).toMatchObject({
    status: 422,
    details: { field: "summary" },
  });
});
