import { Button, Icon, Row, Rows } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../data/client";
import { seed, useQuery } from "../data/hooks";
import { href } from "../router";
import { type WizardStep, useDone } from "./step";
import { personSteps } from "./steps";

// The steps someone skipped, or never did before the setup existed, stay on
// home until they're done or dismissed (ADR 0063).
export function SetupReminders(): ReactElement {
  const dismissed = useQuery("me.setup").data?.dismissed ?? [];

  return (
    <section
      aria-label="Finish setting up"
      className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-1.5 px-4 not-has-[li]:hidden"
    >
      <h2 className="text-label font-medium text-fg-dim">Finish setting up</h2>
      <Rows>
        {personSteps()
          .filter(({ id }) => !dismissed.includes(id))
          .map((step) => (
            <Reminder
              key={step.id}
              step={step}
              onDismiss={() => {
                void request("me.setup.update", {
                  body: { dismiss: step.id },
                }).then((saved) => {
                  seed("me.setup", saved);
                });
              }}
            />
          ))}
      </Rows>
    </section>
  );
}

function Reminder({
  step,
  onDismiss,
}: {
  readonly step: WizardStep;
  readonly onDismiss: () => void;
}): ReactElement | null {
  const done = useDone(step);

  if (done !== false) {
    return null;
  }

  return (
    <Row title={step.step.heading} description={step.step.summary}>
      <a
        href={href("getStarted", { step: step.id })}
        className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-label font-medium text-fg shadow-xs hover:border-line-strong"
      >
        Set up
      </a>
      {step.step.optional === true && (
        <Button
          variant="ghost"
          iconOnly
          aria-label={`Dismiss ${step.step.heading}`}
          onClick={onDismiss}
        >
          <Icon name="x" />
        </Button>
      )}
    </Row>
  );
}
