// The wire keeps ISO times and named owners; the tables keep milliseconds
// and a user id, or NULL for the team (ADR 0064).
const teamOwner = "team";

export function iso(at: number): string {
  return new Date(at).toISOString();
}

export function isoOrNull(at: number | null): string | null {
  return at === null ? null : iso(at);
}

export function ms(at: string): number {
  return Date.parse(at);
}

export function msOrNull(at: string | null): number | null {
  return at === null ? null : ms(at);
}

export function ownerOf(userId: string | null): string {
  return userId ?? teamOwner;
}

export function userOf(ownerId: string): string | null {
  return ownerId === teamOwner ? null : ownerId;
}
