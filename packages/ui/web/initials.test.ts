import { expect, test } from "bun:test";
import { initialsOf, personInitials, plural } from "./initials";

test("takes two letters for a name's mark", () => {
  expect(initialsOf("GitHub")).toBe("Gh");
  expect(initialsOf("maria silva")).toBe("Ms");
  expect(initialsOf("Bea")).toBe("Be");
});

test("writes a person's initials in capitals", () => {
  expect(personInitials("Pedro Klein")).toBe("PK");
  expect(personInitials("maria silva")).toBe("MS");
  expect(personInitials("Bea")).toBe("BE");
});

test("counts a noun, plural unless there is one", () => {
  expect(plural(1, "person", "people")).toBe("1 person");
  expect(plural(3, "person", "people")).toBe("3 people");
  expect(plural(0, "Session")).toBe("0 Sessions");
});
