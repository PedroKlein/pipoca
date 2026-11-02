// Message encryption for Web Push (RFC 8291), with the aes128gcm content
// coding (RFC 8188) in a single record.

export interface Sender {
  readonly keys: CryptoKeyPair;
  readonly salt: Uint8Array<ArrayBuffer>;
}

export async function newSender(): Promise<Sender> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  return { keys, salt: crypto.getRandomValues(new Uint8Array(16)) };
}

// The request body for a push message to a browser's subscription keys.
export async function encrypt(
  plaintext: Uint8Array,
  receiverKey: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  sender: Sender,
): Promise<Uint8Array<ArrayBuffer>> {
  const receiver = await crypto.subtle.importKey(
    "raw",
    receiverKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiver },
    sender.keys.privateKey,
    256,
  );

  const senderKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", sender.keys.publicKey),
  );

  const keyInfo = concat(text("WebPush: info\0"), receiverKey, senderKey);

  const ikm = await hkdf(new Uint8Array(shared), authSecret, keyInfo, 32);

  const cek = await hkdf(
    ikm,
    sender.salt,
    text("Content-Encoding: aes128gcm\0"),
    16,
  );

  const nonce = await hkdf(
    ikm,
    sender.salt,
    text("Content-Encoding: nonce\0"),
    12,
  );

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    concat(plaintext, new Uint8Array([2])),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);

  return concat(
    sender.salt,
    recordSize,
    new Uint8Array([senderKey.length]),
    senderKey,
    new Uint8Array(ciphertext),
  );
}

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );

  return new Uint8Array(bits);
}

function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );

  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  return joined;
}
