import { describe, expect, test } from "bun:test";
import { canSee, owners } from "@pipoca/plugins";
import { fakeSession, fakeUser } from "@pipoca/plugins/testing";

describe("canSee", () => {
  test("a person sees their own records and the team's, not another person's", () => {
    const ana = fakeUser({ id: "ana" });

    expect(canSee(ana, "person:ana")).toBe(true);
    expect(canSee(ana, "team")).toBe(true);
    expect(canSee(ana, "person:bo")).toBe(false);
  });

  test("being an admin doesn't show another person's records", () => {
    expect(canSee(fakeUser({ id: "ana", admin: true }), "person:bo")).toBe(
      false,
    );
  });

  test("a person's Session sees what its person does", () => {
    const caller = {
      kind: "session",
      session: fakeSession({ ownedBy: "person:ana" }),
      actor: "user:ana",
    } as const;

    expect(canSee(caller, "person:ana")).toBe(true);
    expect(canSee(caller, "team")).toBe(true);
    expect(canSee(caller, "person:bo")).toBe(false);
  });

  test("a team Session never sees a person's records, even its starter's", () => {
    const caller = {
      kind: "session",
      session: fakeSession({ ownedBy: "team", startedBy: "ana" }),
      actor: "user:ana",
    } as const;

    expect(canSee(caller, "team")).toBe(true);
    expect(canSee(caller, "person:ana")).toBe(false);
  });
});

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
