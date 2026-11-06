import type { Owner } from "@pipoca/protocol";

const person = "person:";

function personId(owner: Owner): string | undefined {
  return owner === "team" ? undefined : owner.slice(person.length);
}

export const owners = {
  of: (who: { readonly id: string } | string): Owner =>
    `${person}${typeof who === "string" ? who : who.id}`,
  toSql: (owner: Owner): string | null => personId(owner) ?? null,
  fromSql: (userId: string | null): Owner =>
    userId === null ? "team" : `${person}${userId}`,
  personId,
};
