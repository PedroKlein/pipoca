import { Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { command } from "../../data/client";

// What waits for Pi's current step or turn, to send now or take back.
export function Queued({
  sessionId,
  steering,
  followUp,
  report,
}: {
  readonly sessionId: string;
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly report: (error: unknown) => void;
}): ReactElement {
  return (
    <>
      {[
        ...steering.map((t) => ["steer", t] as const),
        ...followUp.map((t) => ["followUp", t] as const),
      ].map(([delivery, queued], index) => (
        <p
          key={`${String(index)}-${queued}`}
          className="flex max-w-[80%] items-start gap-2 self-end rounded-lg border border-dashed border-line-strong bg-elevated py-1 pr-1 pl-3 text-ui text-fg-dim"
        >
          <span>
            <span className="mr-2 text-caption font-medium">
              {delivery === "steer" ? "Steering" : "Queued"}
            </span>
            {queued}
          </span>
          {delivery === "followUp" && (
            <button
              type="button"
              aria-label={`Send "${queued}" now`}
              title="Send now"
              onClick={() => {
                command(sessionId, {
                  type: "unqueue",
                  delivery,
                  text: queued,
                  sendNow: true,
                }).catch(report);
              }}
              className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-caption hover:bg-hover hover:text-fg"
            >
              <Icon name="arrow-up" className="size-3.5" />
              Send now
            </button>
          )}
          <button
            type="button"
            aria-label={`Take back "${queued}"`}
            title="Take back"
            onClick={() => {
              command(sessionId, {
                type: "unqueue",
                delivery,
                text: queued,
              }).catch(report);
            }}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover hover:text-fg"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </p>
      ))}
    </>
  );
}
