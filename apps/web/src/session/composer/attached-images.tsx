import type { ImageAttachment } from "@pipoca/protocol";
import { Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { dataUrl } from "./attachments";

export interface Attached extends ImageAttachment {
  readonly id: string;
  readonly name: string;
}

export async function attached(file: File): Promise<Attached> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });

    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error(`couldn't read ${file.name}`));
    });

    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type as ImageAttachment["mimeType"],
    data: url.slice(url.indexOf(",") + 1),
  };
}

export function AttachedImages({
  images,
  onRemove,
}: {
  readonly images: readonly Attached[];
  readonly onRemove: (id: string) => void;
}): ReactElement | null {
  if (images.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2 pt-1">
      {images.map((image) => (
        <li key={image.id} className="relative">
          <img
            src={dataUrl(image)}
            alt={image.name}
            className="size-16 rounded-md border border-line object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            onClick={() => {
              onRemove(image.id);
            }}
            className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-line bg-panel text-fg-dim hover:text-fg"
          >
            <Icon name="x" className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
