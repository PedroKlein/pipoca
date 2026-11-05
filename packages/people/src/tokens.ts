import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// A secret that is shown once and kept only as its hash.
export function secretToken(prefix = "", bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}
