import { imageTypes, type ModelRef } from "@pipoca/protocol";
import { Button, FileButton, Icon, Segmented } from "@pipoca/ui";
import type { ReactElement, RefObject } from "react";
import { command } from "../../data/client";
import type { Feed } from "../feed";
import { ModelMenu } from "./model-menu";
import { type Target, targets } from "./target";

// Pi reads a message sent now after its current step, and a queued one when
// it finishes.
const sendNowKeys = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? "⌘Enter"
  : "Ctrl+Enter";

export function Toolbar({
  sessionId,
  feed,
  models,
  hiddenModels,
  modelMenu,
  talk,
  target,
  onTarget,
  running,
  anyFile,
  uploading,
  starting,
  attach,
  report,
}: {
  readonly sessionId: string;
  readonly feed: Feed;
  readonly models: readonly ModelRef[];
  readonly hiddenModels: readonly string[];
  readonly modelMenu: RefObject<HTMLButtonElement | null>;
  readonly talk: boolean;
  readonly target: Target;
  readonly onTarget: (target: Target) => void;
  readonly running: boolean;
  // A plugin keeps files that aren't images, so the button takes any.
  readonly anyFile: boolean;
  readonly uploading: boolean;
  readonly starting: boolean;
  readonly attach: (files: readonly File[]) => void;
  readonly report: (error: unknown) => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <FileButton
        variant="ghost"
        iconOnly
        icon="paperclip"
        title={anyFile ? "Attach files" : "Attach images"}
        aria-label={anyFile ? "Attach files" : "Attach images"}
        multiple
        {...(!anyFile && { accept: imageTypes.join(",") })}
        onFiles={attach}
        className="-ml-2"
      />
      {feed.settings && (
        <ModelMenu
          settings={feed.settings}
          models={models}
          hiddenModels={hiddenModels}
          modelMenu={modelMenu}
          onModel={(model) => {
            command(sessionId, { type: "set_model", model }).catch(report);
          }}
          onLogin={() => {
            command(sessionId, {
              type: "message",
              text: "/login",
              requestId: crypto.randomUUID(),
              delivery: "followUp",
            }).catch(report);
          }}
          onThinking={(level) => {
            command(sessionId, { type: "set_thinking", level }).catch(report);
          }}
        />
      )}
      {talk && (
        <Segmented
          label="Send to"
          value={target}
          options={targets}
          onChange={onTarget}
        />
      )}
      {uploading ? (
        <span className="flex-1 truncate text-caption text-fg-dim">
          Send waits for uploads
        </span>
      ) : (
        <span className="flex-1 truncate text-caption text-fg-dim max-md:hidden">
          {running ? `Enter queues · ${sendNowKeys} sends now` : "Enter sends"}{" "}
          · / commands · @ files
        </span>
      )}
      {running && (
        <Button
          variant="default"
          iconOnly
          aria-label="Stop"
          className="rounded-full"
          onClick={() => {
            command(sessionId, { type: "abort" }).catch(report);
          }}
        >
          <Icon name="stop" />
        </Button>
      )}
      <Button
        variant="primary"
        iconOnly
        type="submit"
        aria-label="Send"
        disabled={uploading || starting}
        className="ml-auto rounded-full"
      >
        <Icon name="arrow-up" />
      </Button>
    </div>
  );
}
