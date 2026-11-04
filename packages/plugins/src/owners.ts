import type { Owner } from "@pipoca/protocol";
import type { RouteCaller } from "./plugin";

// Whether a caller may see an owner's records, for a plugin to check on its
// own routes (ADR 0067). Team work is open to every user (ADR 0064). Anyone
// can steer a team Session, so it never sees a person's records.
export function canSee(caller: RouteCaller, owner: Owner): boolean {
  return owner === "team" || owner === ownerOf(caller);
}

function ownerOf(caller: RouteCaller): Owner {
  return caller.kind === "user"
    ? `person:${caller.actor.slice("user:".length)}`
    : caller.session.ownedBy;
}
