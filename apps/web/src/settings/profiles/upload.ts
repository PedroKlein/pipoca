import { ok } from "../../responses";
import { profilePath } from "@pipoca/protocol";

const errors: Readonly<Record<string, string>> = {
  default: "Make another Profile the default before deleting this one.",
  in_use: "Sessions still use this Profile. Archive them first.",
  admin_only: "Only admins change shared Profiles.",
};

export function messageOf(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : String(reason);

  return errors[code] ?? code;
}

export function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(text);
}

// What machines keep for themselves, such as auth.json, is never sent
// (ADR 0041).
export async function upload(
  url: string,
  picked: readonly File[],
  { folder, picked: pickedFolder }: { folder?: string; picked: boolean },
): Promise<void> {
  const files: Record<string, string> = {};

  for (const file of picked) {
    const relative = pickedFolder
      ? file.webkitRelativePath
          .split("/")
          .slice(folder === undefined ? 1 : 0)
          .join("/")
      : file.name;

    const path = `${folder ?? ""}${relative}`;

    if (profilePath(path)) {
      files[path] = base64(new Uint8Array(await file.arrayBuffer()));
    }
  }

  await ok(
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    }),
  );
}
