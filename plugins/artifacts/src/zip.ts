import { crc32, deflateRawSync } from "node:zlib";

// A .zip of files (PKWARE APPNOTE 6.3.10), each deflated, without ZIP64: an
// artifact is far below its 4 GB and 65,535 files.
export function zip(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  modified: Date,
): Uint8Array {
  const time =
    (modified.getHours() << 11) |
    (modified.getMinutes() << 5) |
    (modified.getSeconds() >> 1);

  const date =
    ((Math.max(modified.getFullYear(), 1980) - 1980) << 9) |
    ((modified.getMonth() + 1) << 5) |
    modified.getDate();

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const { path, bytes } of files) {
    const name = new TextEncoder().encode(path);
    const packed = deflateRawSync(bytes);

    // Version 2.0, UTF-8 names, deflated, then when, CRC-32 and sizes.
    const shared = (header: DataView, at: number): void => {
      header.setUint16(at, 20, true);
      header.setUint16(at + 2, 0x0800, true);
      header.setUint16(at + 4, 8, true);
      header.setUint16(at + 6, time, true);
      header.setUint16(at + 8, date, true);
      header.setUint32(at + 10, crc32(bytes), true);
      header.setUint32(at + 14, packed.length, true);
      header.setUint32(at + 18, bytes.length, true);
      header.setUint16(at + 22, name.length, true);
    };

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034b50, true);
    shared(localView, 4);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);

    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    shared(entryView, 6);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, packed);
    central.push(entry);
    offset += local.length + packed.length;
  }

  const size = central.reduce((sum, each) => sum + each.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, size, true);
  endView.setUint32(16, offset, true);

  return Buffer.concat([...parts, ...central, end]);
}
