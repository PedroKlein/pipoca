import { imageLimits } from "@pipoca/protocol";
import { type RefObject, useState } from "react";
import { command, request } from "../../data/client";
import type { Feed } from "../feed";
import { type Attached, attached } from "./attached-images";
import { admit, isImage } from "./attachments";
import type { Replying } from "./composer";
import { browserCommand } from "./suggest";
import type { Target } from "./target";

// The images attached to the next message, and sending it to Pi or the team.
export function useSend({
  sessionId,
  feed,
  team,
  target,
  replying,
  onReplied,
  report,
  textRef,
  modelMenuRef,
  keepsFiles,
  uploading,
}: {
  readonly sessionId: string;
  readonly feed: Feed;
  readonly team: boolean;
  readonly target: Target;
  readonly replying: Replying | undefined;
  readonly onReplied: (() => void) | undefined;
  readonly report: (error: unknown) => void;
  readonly textRef: RefObject<HTMLTextAreaElement | null>;
  readonly modelMenuRef: RefObject<HTMLButtonElement | null>;
  // A plugin keeps files that aren't images, until the message is sent.
  readonly keepsFiles: boolean;
  // Files are still uploading, so Pi wouldn't have them yet.
  readonly uploading: boolean;
}): {
  readonly images: readonly Attached[];
  readonly setImages: (
    change: (current: readonly Attached[]) => readonly Attached[],
  ) => void;
  readonly files: readonly File[];
  readonly setFiles: (
    change: (current: readonly File[]) => readonly File[],
  ) => void;
  readonly attach: (files: readonly File[]) => void;
  readonly send: (delivery: "steer" | "followUp") => void;
} {
  const [images, setImages] = useState<readonly Attached[]>([]);
  const [files, setFiles] = useState<readonly File[]>([]);

  const attach = (picked: readonly File[]): void => {
    const others = picked.filter((file) => !isImage(file));

    if (keepsFiles && others.length > 0) {
      setFiles((current) => [...current, ...others]);
    }

    const { admitted, problems } = admit(
      images.length,
      keepsFiles ? picked.filter(isImage) : picked,
    );

    if (problems.length > 0) {
      report(problems.join(" "));
    }

    void Promise.all(admitted.map(attached)).then((read) => {
      setImages((current) => [...current, ...read].slice(0, imageLimits.count));
    }, report);
  };

  const runInBrowser = (name: "copy" | "model" | "thinking"): void => {
    if (name === "copy") {
      const answer = feed.items
        .flatMap((item) => (item.role === "assistant" ? [item.text] : []))
        .at(-1);

      navigator.clipboard.writeText(answer ?? "").catch(report);

      return;
    }

    modelMenuRef.current?.click();
  };

  const send = (delivery: "steer" | "followUp"): void => {
    const box = textRef.current;
    const message = box?.value.trim() ?? "";
    if (!box || uploading || (message === "" && images.length === 0)) {
      return;
    }

    const local = images.length === 0 ? browserCommand(message) : undefined;
    if (local) {
      box.value = "";
      runInBrowser(local);

      return;
    }

    const toPeople = team && target !== "pi";

    if (toPeople && images.length > 0) {
      report("Images go to Pi only. Switch to To Pi to send them.");

      return;
    }

    box.value = "";
    setImages([]);

    const quote = replying?.quote;
    onReplied?.();

    const restore = (error: unknown): void => {
      box.value = box.value === "" ? message : `${message}\n${box.value}`;
      report(error);
    };

    if (toPeople) {
      request("sessions.messages.create", {
        params: { id: sessionId },
        body: {
          to: target,
          text: message,
          ...(quote && { quote }),
          requestId: crypto.randomUUID(),
        },
      }).catch(restore);

      return;
    }

    setFiles([]);

    command(sessionId, {
      ...(quote && { quote }),
      type: "message",
      text: message,
      ...(images.length > 0 && {
        images: images.map(({ mimeType, data }) => ({ mimeType, data })),
      }),
      requestId: crypto.randomUUID(),
      delivery,
    }).catch((error: unknown) => {
      box.value = box.value === "" ? message : `${message}\n${box.value}`;

      setImages((current) =>
        [...images, ...current].slice(0, imageLimits.count),
      );

      report(error);
    });
  };

  return { images, setImages, files, setFiles, attach, send };
}
