import {
  Button,
  cn,
  Hero,
  SetupShell,
  Step,
  Stepper,
  type StepState,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useEnvironments, useTemplates } from "../hooks";
import { useNewcomers } from "../settings/people/newcomers";
import { PluginBoundary } from "../plugin-boundary";
import { type WizardStep, useDone } from "./step";
import { setupSteps } from "./steps";
import { DoneStep } from "./done-step";

// A full-screen setup, after the account step on the sign-in page, that
// ends on what Pi will use (ADR 0063).
export function SetupWizard({
  user,
  admin,
  start,
  onFinish,
}: {
  readonly user: string;
  readonly admin: boolean;
  // The step a reminder on home opened.
  readonly start: string | undefined;
  readonly onFinish: () => void;
}): ReactElement {
  const steps = setupSteps();
  const newcomers = useNewcomers().value;

  useNewcomerEnvironment(newcomers.template);

  const first = Math.max(
    0,
    steps.findIndex(({ id }) => id === start),
  );

  const [at, setAt] = useState(first);
  const step = steps[at];
  const total = steps.length + 2;

  const finish = (): void => {
    void api("me.setup.update", { body: { finished: true } }).finally(onFinish);
  };

  const leave = (): void => {
    location.hash = "";
    finish();
  };

  return (
    <SetupShell
      steps={{ total, at: at + 1 }}
      aside={
        step === undefined ? (
          <Button variant="ghost" size="sm" onClick={leave}>
            Done
          </Button>
        ) : (
          `Step ${String(at + 2)} of ${String(total)}`
        )
      }
    >
      <div
        className={cn(
          !admin &&
            "mx-auto flex w-full max-w-268 flex-col gap-6 px-4 md:flex-row md:gap-14",
        )}
      >
        {!admin && <JoinSteps user={user} steps={steps} at={at} />}
        <main
          className={cn(
            "mx-auto flex w-full animate-rise-in flex-col gap-8 px-4 pt-8 pb-16 md:pt-11",
            step === undefined || step.step.wide === true
              ? "max-w-198"
              : "max-w-158",
          )}
        >
          {step === undefined ? (
            <DoneStep
              user={user}
              admin={admin}
              steps={steps}
              onStarted={finish}
              onLeave={finish}
            />
          ) : (
            <CurrentStep
              key={step.id}
              step={step}
              required={newcomers.required.includes(step.id)}
              onBack={
                at === 0
                  ? undefined
                  : () => {
                      setAt(at - 1);
                    }
              }
              onNext={() => {
                setAt(at + 1);
              }}
            />
          )}
        </main>
      </div>
    </SetupShell>
  );
}

// Someone joining a team sees their steps beside the page, and that what
// the team shares is already set up for them (ADR 0063).
function JoinSteps({
  user,
  steps,
  at,
}: {
  readonly user: string;
  readonly steps: readonly WizardStep[];
  readonly at: number;
}): ReactElement {
  const rows = [
    { id: "signed-in", title: "Signed in", summary: user },
    ...steps.map(({ id, step }) => ({
      id,
      title: step.title,
      summary: step.optional === true ? "Optional" : step.summary,
    })),
  ];

  return (
    <aside className="flex shrink-0 flex-col gap-5 pt-8 md:w-55 md:pt-11">
      <Stepper label="Your setup">
        {rows.map((row, index) => (
          <Step
            key={row.id}
            number={index + 1}
            state={stepState(index, at + 1)}
            title={row.title}
            description={row.summary}
          />
        ))}
      </Stepper>
      <p className="border-t border-line pt-4 text-caption text-fg-dim">
        What your team shares, such as machines, models and sign-in, is set up
        already. You can see it in Settings.
      </p>
    </aside>
  );
}

// Someone who joins gets an Environment from the template an admin picked
// for new people, once, so Where is ready for them.
function useNewcomerEnvironment(template: string | null): void {
  const environments = useEnvironments();
  const templates = useTemplates().value;
  const asked = useRef(false);
  const name = templates.find(({ id }) => id === template)?.name;

  useEffect(() => {
    if (
      asked.current ||
      template === null ||
      name === undefined ||
      !environments.loaded ||
      environments.value.some(({ templateId }) => templateId === template)
    ) {
      return;
    }

    asked.current = true;

    api("environments.create", { body: { name, template } }).then(
      environments.reload,
      () => undefined,
    );
  }, [template, name, environments]);
}

function stepState(index: number, current: number): StepState {
  if (index < current) {
    return "done";
  }

  return index === current ? "current" : "next";
}

export function Heading({
  title,
  description,
  centered = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly centered?: boolean;
}): ReactElement {
  return (
    <Hero title={title} centered={centered}>
      {description}
    </Hero>
  );
}

function CurrentStep({
  step,
  required,
  onBack,
  onNext,
}: {
  readonly step: WizardStep;
  readonly required: boolean;
  readonly onBack: (() => void) | undefined;
  readonly onNext: () => void;
}): ReactElement {
  const done = useDone(step);
  const { id, step: about, context } = step;

  return (
    <>
      <Heading title={about.heading} description={about.description} />
      <PluginBoundary name={id}>
        <about.Step context={context} />
      </PluginBoundary>
      <div className="flex items-center gap-3">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <span className="flex-1" />
        {about.optional === true && !required && done !== true && (
          <Button variant="ghost" onClick={onNext}>
            Skip for now
          </Button>
        )}
        <Button
          variant="primary"
          disabled={done !== true}
          title={done === true ? undefined : "Finish this step first"}
          onClick={onNext}
          className="h-11 px-5 text-prose"
        >
          Continue
        </Button>
      </div>
    </>
  );
}
