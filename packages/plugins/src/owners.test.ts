import { describe, expect, test } from "bun:test";
import { owners } from "@pipoca/plugins";

describe("owners", () => {
  test("a person's owner is stored as their id and the team's as NULL", () => {
    expect(owners.of({ id: "ana" })).toBe("person:ana");
    expect(owners.of("ana")).toBe("person:ana");
    expect(owners.toSql("person:ana")).toBe("ana");
    expect(owners.toSql("team")).toBeNull();
    expect(owners.fromSql("ana")).toBe("person:ana");
    expect(owners.fromSql(null)).toBe("team");
    expect(owners.personId("person:ana")).toBe("ana");
    expect(owners.personId("team")).toBeUndefined();
  });
});
