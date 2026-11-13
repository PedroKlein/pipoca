import { Button, ErrorText } from "@pipoca/ui";
import { createContext, type ReactElement, useContext } from "react";
import { useAction } from "../data/hooks";

export interface Footing {
  // Undefined on the very first step.
  readonly back: (() => void) | undefined;
  readonly next: () => Promise<void>;
  readonly done: boolean | undefined;
  // Optional and not required for this person.
  readonly skippable: boolean;
  readonly label: string;
}

export const FooterContext = createContext<Footing>({
  back: undefined,
  next: async () => Promise.resolve(),
  done: undefined,
  skippable: false,
  label: "Continue",
});

// Back, Skip and Continue under a step (ADR 0072). An answer the step
// preselected is saved by Continue, so a step the team already answered
// takes one click. Skip only shows while the step has no answer.
export function StepFooter({
  answer,
}: {
  readonly answer?: (() => Promise<void>) | undefined;
}): ReactElement {
  const { back, next, done, skippable, label } = useContext(FooterContext);
  const ready = done === true || answer !== undefined;

  const go = useAction(async (save: boolean) => {
    if (save) {
      await answer?.();
    }

    await next();
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {back === undefined ? (
          <span className="flex-1 text-caption text-fg-dim">
            Leave anytime: the rest waits on Home.
          </span>
        ) : (
          <>
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
            <span className="flex-1" />
          </>
        )}
        {skippable && !ready && (
          <Button
            variant="ghost"
            onClick={() => {
              void go.run(false);
            }}
          >
            Skip for now
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!ready || go.pending}
          title={ready ? undefined : "Finish this step first"}
          onClick={() => {
            void go.run(true);
          }}
          size="lg"
        >
          {label}
        </Button>
      </div>
      <ErrorText size="caption">{go.error}</ErrorText>
    </div>
  );
}
