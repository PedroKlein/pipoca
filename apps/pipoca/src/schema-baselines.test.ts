import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { builtInDefinitions } from "./built-in";
import { kernelSchema } from "./sqlite/schema";

// The sha256 of each released baseline schema. Databases already hold it as
// version 0, so a change to it never reaches them (ADR 0070).
const pinned: Readonly<Record<string, string>> = {
  kernel: "beb1f337f8a249af360c5da84ef7c4b9547417923924ce6fc04286ec8b0b0e76",
  ask: "1571ca4a1d8fb4c417db6c5b32f62e977e8a19e9bdd1c1f7ffed5ae172a28ce4",
  artifacts: "b1963b25fada14a4a935714a93aeb3a90dfbe5d4123d4c7a98e5f5a661abf665",
  files: "359d9940c0fee3b2d4bdbb18017da55e11939c8474c7e7ca3d4ff1faf94de9dc",
  email: "6cb2e37bcaab2b6df2fc0fd279e5ef2ad1d2cdbd14ea39e2e602486630ec10a9",
  "git-hosts":
    "9a879e77d985a760b187201ebe81baad332aefa119398178d6d53f54401146a1",
  local: "05f430d8d350127484d7952df9cd10c349e627d6078e3c2f65981a39b3349d29",
  logins: "fbe6a10fc6e45c850622c2aebf6db4c04ae11b9cd295f0cd359887b17edb9556",
  models: "7f296143a20f7b285cdd48e0472b671d40bc7e5f338ad4361873d734be133317",
  oidc: "b215078bf9aaafd65d284a6e664400c596c5c91cbc6b5d9b5fea2651c70b5fbf",
  projects: "b4eae8e7e4c7ec79f8dfbe6deabd1b1173a2ad7a90e6b8bd469cb89d09ea2055",
  push: "800c29c50f31166e217dafc6aea42edb40c800cca105f6fc7e936aa7c33767ef",
  routines: "0bc416422cb270ebe9ebb49484b327f5d24ce10678916460a2e39cf90892270f",
  slack: "171efeb621f48fe93781b63e5ed22aa59ab888bbe4f30739363223bba41beca9",
  usage: "3e3a23f6e3a97f9160f934206874a8a5e34d503c6971d10c1f9d7c1b00ccf8ef",
};

test("keeps each released baseline schema as it was", () => {
  const baselines = [
    { owner: kernelSchema.owner, sql: kernelSchema.sql },
    ...builtInDefinitions.flatMap(({ id, schema }) =>
      schema === undefined ? [] : [{ owner: id, sql: schema }],
    ),
  ];

  const changed = baselines.flatMap(({ owner, sql }) => {
    const hash = createHash("sha256").update(sql).digest("hex");

    return pinned[owner] === hash
      ? []
      : [
          `${owner}'s baseline schema is now ${hash}: add a migration instead of editing it. Pin the new hash here only for a new schema, or an edit that changes no table, such as a comment.`,
        ];
  });

  expect(changed).toEqual([]);
});
