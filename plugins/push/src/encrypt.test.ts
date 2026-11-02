import { expect, test } from "bun:test";
import { encrypt } from "./encrypt";

const bytes = (base64url: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(base64url, "base64url"));

// RFC 8291, Appendix A.
test("encrypts the RFC 8291 example to its body", async () => {
  const senderPublic = bytes(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );

  const point = {
    kty: "EC",
    crv: "P-256",
    x: Buffer.from(senderPublic.subarray(1, 33)).toString("base64url"),
    y: Buffer.from(senderPublic.subarray(33)).toString("base64url"),
  };

  const keys = {
    publicKey: await crypto.subtle.importKey(
      "jwk",
      point,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    ),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...point, d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw" },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
  };

  const body = await encrypt(
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    bytes(
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    ),
    bytes("BTBZMqHH6r4Tts7J_aSIgg"),
    { keys, salt: bytes("DGv6ra1nlYgDCS1FRnbzlw") },
  );

  expect(Buffer.from(body).toString("base64url")).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
