import { Button, Icon } from "@pipoca/ui";
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
            <Button
              variant="ghost"
              size="xs"
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
            >
              <Icon name="arrow-up" className="size-3.5" />
              Send now
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Take back "${queued}"`}
            title="Take back"
            onClick={() => {
              command(sessionId, {
                type: "unqueue",
                delivery,
                text: queued,
              }).catch(report);
            }}
          >
            <Icon name="x" className="size-3.5" />
          </Button>
        </p>
      ))}
    </>
  );
}
