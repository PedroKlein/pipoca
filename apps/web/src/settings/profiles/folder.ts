import { type ApiReply, profilePath } from "@pipoca/protocol";
import { request } from "../../data/client";
import type { Layer } from "./layers";

// The files of a Profile, or of a layer under every Profile.
export interface Folder {
  // Names the folder, such as for a cache key.
  readonly key: string;
  readonly list: () => Promise<ApiReply<"profiles.files">>;
  // A file that isn't there reads as "".
  readonly read: (path: string) => Promise<string>;
  readonly write: (path: string, text: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  // Files as { path: base64 }.
  readonly upload: (files: Readonly<Record<string, string>>) => Promise<void>;
}

const missing = (): string => "";

export function profileFolder(id: string): Folder {
  const file = (path: string) => ({
    params: { id, path: encodeURIComponent(path) },
  });

  return {
    key: `profile ${id}`,
    list: async () => request("profiles.files", { params: { id } }),
    read: async (path) =>
      request("profiles.file", file(path)).then(
        async (response) => response.text(),
        missing,
      ),
    write: async (path, text) => {
      await request("profiles.file.write", { ...file(path), body: text });
    },
    remove: async (path) => {
      await request("profiles.file.remove", file(path));
    },
    upload: async (files) => {
      await request("profiles.files.upload", {
        params: { id },
        body: { files },
      });
    },
  };
}

export function layerFolder(layer: Layer): Folder {
  const file = (path: string) => ({
    params: { path: encodeURIComponent(path) },
  });

  if (layer === "base") {
    return {
      key: "layer base",
      list: async () => request("settings.baseProfile.files"),
      read: async (path) =>
        request("settings.baseProfile.file", file(path)).then(
          async (response) => response.text(),
          missing,
        ),
      write: async (path, text) => {
        await request("settings.baseProfile.file.write", {
          ...file(path),
          body: text,
        });
      },
      remove: async (path) => {
        await request("settings.baseProfile.file.remove", file(path));
      },
      upload: async (files) => {
        await request("settings.baseProfile.files.upload", { body: { files } });
      },
    };
  }

  return {
    key: "layer defaults",
    list: async () => request("me.profileDefaults.files"),
    read: async (path) =>
      request("me.profileDefaults.file", file(path)).then(
        async (response) => response.text(),
        missing,
      ),
    write: async (path, text) => {
      await request("me.profileDefaults.file.write", {
        ...file(path),
        body: text,
      });
    },
    remove: async (path) => {
      await request("me.profileDefaults.file.remove", file(path));
    },
    upload: async (files) => {
      await request("me.profileDefaults.files.upload", { body: { files } });
    },
  };
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
  folder: Folder,
  picked: readonly File[],
  { under, picked: pickedFolder }: { under?: string; picked: boolean },
): Promise<void> {
  const files: Record<string, string> = {};

  for (const file of picked) {
    const relative = pickedFolder
      ? file.webkitRelativePath
          .split("/")
          .slice(under === undefined ? 1 : 0)
          .join("/")
      : file.name;

    const path = `${under ?? ""}${relative}`;

    if (profilePath(path)) {
      files[path] = base64(new Uint8Array(await file.arrayBuffer()));
    }
  }

  await folder.upload(files);
}
