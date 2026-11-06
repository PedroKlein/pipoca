import type { SessionAccess } from "@pipoca/protocol";

export interface Viewer {
  readonly id: string;
  readonly admin: boolean;
}

// Who owns something: a person's id, or "team" (ADR 0064). Team work also
// says who started it and who it is open to.
export interface Owned {
  readonly owner: string;
  readonly startedBy?: string | null;
  readonly access?: SessionAccess;
}

const teamOwner = "team";

// What the team owns without an access list of its own, such as an
// Environment, everyone sees and only admins change.
function reach(viewer: Viewer, owned: Owned): "steers" | "sees" | null {
  if (owned.owner !== teamOwner) {
    return owned.owner === viewer.id ? "steers" : null;
  }

  if (owned.access === undefined) {
    return viewer.admin ? "steers" : "sees";
  }

  if (owned.access.kind === "team" || owned.startedBy === viewer.id) {
    return "steers";
  }

  if (owned.access.kind === "view") {
    return "sees";
  }

  return owned.access.people.includes(viewer.id) ? "steers" : null;
}

// Whether the viewer may open it, if only to watch.
export function canSee(viewer: Viewer, owned: Owned | undefined): boolean {
  return owned !== undefined && reach(viewer, owned) !== null;
}

// Whether the viewer may act in it or change it.
export function canSteer(viewer: Viewer, owned: Owned | undefined): boolean {
  return owned !== undefined && reach(viewer, owned) === "steers";
}

// Whether the viewer may stop, archive or delete it: whoever steers it, and
// any admin (ADR 0049).
export function canManage(viewer: Viewer, owned: Owned | undefined): boolean {
  return owned !== undefined && (viewer.admin || canSteer(viewer, owned));
}
