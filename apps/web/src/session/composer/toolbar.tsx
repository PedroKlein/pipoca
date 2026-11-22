import { type Environment, imageTypes, type ModelInfo } from "@pipoca/protocol";
import { AttachMenu } from "@pipoca/plugins/web";
import { Button, Icon, Menu } from "@pipoca/ui";
import type { ReactElement, ReactNode, RefObject } from "react";
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
  unavailableModels,
  modelMenu,
  team,
  talk,
  target,
  onTarget,
  running,
  anyFile,
  uploading,
  attach,
  report,
  meter,
  children,
}: {
  readonly sessionId: string;
  readonly feed: Feed;
  readonly models: readonly ModelInfo[];
  readonly hiddenModels: readonly string[];
  readonly unavailableModels: Environment["unavailableModels"];
  readonly modelMenu: RefObject<HTMLButtonElement | null>;
  readonly team: boolean;
  readonly talk: boolean;
  readonly target: Target;
  readonly onTarget: (target: Target) => void;
  readonly running: boolean;
  // A plugin keeps files that aren't images, so the button takes any.
  readonly anyFile: boolean;
  readonly uploading: boolean;
  readonly attach: (files: readonly File[]) => void;
  readonly report: (error: unknown) => void;
  // Plugins' small readouts beside the model, such as how full the context
  // is.
  readonly meter: ReactNode;
  // The plugins' rows of the + menu.
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 px-1">
      <AttachMenu
        label={anyFile ? "Attach files" : "Attach images"}
        {...(!anyFile && { accept: imageTypes.join(",") })}
        onFiles={attach}
      >
        {children}
      </AttachMenu>
      {talk && (
        <Menu
          label={`Send to: ${targets.find(({ value }) => value === target)?.label ?? ""}`}
          side="above"
          align="start"
          size="xs"
          trigger={
            <>
              {targets.find(({ value }) => value === target)?.label}
              <Icon name="chevron-down" className="size-3" />
            </>
          }
          items={targets.map(({ value, label }) => ({
            label,
            checked: value === target,
            run: () => {
              onTarget(value);
            },
          }))}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-caption text-fg-dim">
        {uploading && "Send waits for uploads"}
        {!uploading && running && (
          <span className="max-md:hidden">{`Enter queues · ${sendNowKeys} sends now`}</span>
        )}
      </span>
      {meter}
      {feed.settings && (
        <ModelMenu
          settings={feed.settings}
          models={models}
          hiddenModels={hiddenModels}
          unavailableModels={unavailableModels}
          modelMenu={modelMenu}
          onModel={(model) => {
            command(sessionId, { type: "set_model", model }).catch(report);
          }}
          {...(!team && {
            onLogin: () => {
              command(sessionId, {
                type: "message",
                text: "/login",
                requestId: crypto.randomUUID(),
                delivery: "followUp",
              }).catch(report);
            },
          })}
          onThinking={(level) => {
            command(sessionId, { type: "set_thinking", level }).catch(report);
          }}
        />
      )}
    </div>
  );
}

// Stop while Pi works, and Send, beside the message.
export function SendButtons({
  sessionId,
  running,
  disabled,
  report,
}: {
  readonly sessionId: string;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly report: (error: unknown) => void;
}): ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-1.5 self-end">
      {running && (
        <Button
          variant="default"
          iconOnly
          size="sm"
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
        size="sm"
        type="submit"
        aria-label="Send"
        disabled={disabled}
        className="rounded-full"
      >
        <Icon name="arrow-up" />
      </Button>
    </span>
  );
}
