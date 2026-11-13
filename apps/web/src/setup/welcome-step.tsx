import { Badge, Hero, Icon, Row, Rows } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useMe, useQuery } from "../data/hooks";
import { href } from "../router";
import { useNewcomers } from "../settings/people/newcomers";
import { packageText } from "../settings/profiles/layers";
import { nameOf } from "../settings/profiles/packages";
import { StepFooter } from "./footer";
import { type WizardStep, useDone } from "./step";

// Where each person's setup starts on a team server: what the team set up
// already, and the steps ahead with the team's answers picked (ADR 0072).
export function WelcomeStep({
  steps,
}: {
  readonly steps: readonly WizardStep[];
}): ReactElement {
  const { admin } = useMe();
  const team = useQuery("settings.team").data?.name ?? null;
  const base = useQuery("settings.baseProfile").data;

  const packages = (base?.packages ?? []).map((pkg) =>
    nameOf(packageText(pkg)),
  );

  return (
    <>
      <Hero
        title={
          team === null
            ? "Welcome to your team's Pipoca"
            : `Welcome to ${team}'s Pipoca`
        }
      >
        {admin
          ? "That's what the team shares. Now your own setup, like everyone else's, with the team's choices already picked."
          : "Your team set most things up. You'll still see each step, with the team's choices already picked."}
      </Hero>
      {packages.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-label font-medium text-fg-strong">
            Ready for you
          </h2>
          <Rows label="Ready for you">
            <Row
              leading={<Icon name="check" className="text-done" />}
              title="Team tools"
              description={`${packages.join(", ")} in every Session`}
            />
          </Rows>
        </section>
      )}
      <section className="flex flex-col gap-2.5">
        <h2 className="text-label font-medium text-fg-strong">Your steps</h2>
        <Rows label="Your steps">
          {steps.map((step, index) => (
            <StepRow key={step.id} step={step} number={index + 1} />
          ))}
        </Rows>
      </section>
      {admin && (
        <p className="flex items-center gap-2.5 rounded-lg bg-hover px-4 py-3 text-label text-fg">
          <Icon name="check" className="text-fg-dim" />
          <span>
            Server setup is done. Change any of it later in{" "}
            <a href={href("teamSetup")} className="underline">
              Team setup
            </a>
            .
          </span>
        </p>
      )}
      <StepFooter />
    </>
  );
}

function StepRow({
  step,
  number,
}: {
  readonly step: WizardStep;
  readonly number: number;
}): ReactElement {
  const done = useDone(step);
  const newcomers = useNewcomers();

  const required =
    step.step.optional !== true || newcomers.required.includes(step.id);

  const picked =
    done === true || (step.id === "where" && newcomers.template !== null);

  return (
    <Row
      leading={
        <span className="grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong bg-elevated text-caption font-semibold text-fg-dim">
          {number}
        </span>
      }
      title={step.step.title}
      description={step.step.summary}
    >
      {required && !picked && <Badge state="waiting">Required</Badge>}
      {picked && <Badge state="done">Picked</Badge>}
      {!required && !picked && <Badge>Optional</Badge>}
    </Row>
  );
}
