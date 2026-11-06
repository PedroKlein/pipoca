import { expect, test } from "bun:test";
import { canManage, canSee, canSteer, type Viewer } from "./index";

const ana: Viewer = { id: "ana", admin: false };
const bea: Viewer = { id: "bea", admin: false };
const admin: Viewer = { id: "root", admin: true };

const rights = (viewer: Viewer, owned: Parameters<typeof canSee>[1]) => [
  canSee(viewer, owned),
  canSteer(viewer, owned),
  canManage(viewer, owned),
];

test("a person reaches only what is theirs, and an admin only manages it", () => {
  const anas = { owner: "ana" };

  expect(rights(ana, anas)).toEqual([true, true, true]);
  expect(rights(bea, anas)).toEqual([false, false, false]);
  expect(rights(admin, anas)).toEqual([false, false, true]);
});

test("everyone sees what the team owns without an access list, and admins change it", () => {
  const environment = { owner: "team" };

  expect(rights(ana, environment)).toEqual([true, false, false]);
  expect(rights(admin, environment)).toEqual([true, true, true]);
});

test("team work follows its access list, and its starter always steers it", () => {
  const open = {
    owner: "team",
    startedBy: "ana",
    access: { kind: "team" },
  } as const;

  const view = {
    owner: "team",
    startedBy: "ana",
    access: { kind: "view" },
  } as const;

  const named = {
    owner: "team",
    startedBy: "ana",
    access: { kind: "named", people: ["bea"] },
  } as const;

  const outsider: Viewer = { id: "cid", admin: false };

  expect(rights(bea, open)).toEqual([true, true, true]);
  expect(rights(bea, view)).toEqual([true, false, false]);
  expect(rights(ana, view)).toEqual([true, true, true]);
  expect(rights(bea, named)).toEqual([true, true, true]);
  expect(rights(outsider, named)).toEqual([false, false, false]);
  expect(rights(admin, named)).toEqual([false, false, true]);
});

test("nothing is reached when there is nothing", () => {
  expect(rights(admin, undefined)).toEqual([false, false, false]);
});
