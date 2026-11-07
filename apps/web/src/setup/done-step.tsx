import { Button, Hero, Row, Rows } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useQuery } from "../data/hooks";
import { NewSessionForm } from "../shell/new-session";
import { type WizardStep, useDone } from "./step";

// The end of each person's setup: what their first Session will use, and
// where to ask for it (ADR 0072).
export function DoneStep({
  steps,
  onBack,
  onStarted,
  onLeave,
}: {
  readonly steps: readonly WizardStep[];
  readonly onBack: (() => void) | undefined;
  readonly onStarted: () => void;
  readonly onLeave: () => void;
}): ReactElement {
  const places = (useQuery("environments.list").data ?? []).map(
    ({ name }) => name,
  );

  return (
    <>
      <Hero title="You're set">
        Here&apos;s what your first Session will use. Change any of it in
        Settings.
      </Hero>
      <Rows label="What Pi will use">
        <Row title="Runs on">
          <span className="text-label text-fg-dim">
            {places.length === 0 ? "Nothing yet" : places.join(", ")}
          </span>
        </Row>
        {steps
          .filter(({ id }) => id !== "where")
          .map((step) => (
            <Summary key={step.id} step={step} />
          ))}
      </Rows>
      <div className="rounded-xl border border-line bg-elevated pt-2 shadow-xs">
        <NewSessionForm
          placeholder="What should Pi do first?"
          onStarted={onStarted}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={onBack === undefined}
        >
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onLeave}>
          Go to home
        </Button>
      </div>
    </>
  );
}

function Summary({ step }: { readonly step: WizardStep }): ReactElement {
  const done = useDone(step);

  return (
    <Row title={step.step.title}>
      <span className="text-label text-fg-dim">
        {done === true ? "Set up" : "Skipped for now"}
      </span>
    </Row>
  );
}
