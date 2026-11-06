import { cardClass, cn, Icon, linkCardClass } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useMe } from "../data/hooks";
import { href } from "../router";
import { NewSessionForm } from "../shell/new-session";
import { type WizardStep, useDone } from "./step";
import { Heading } from "./wizard";

export function DoneStep({
  steps,
  onStarted,
  onLeave,
}: {
  readonly steps: readonly WizardStep[];
  readonly onStarted: () => void;
  readonly onLeave: () => void;
}): ReactElement {
  const { user, admin } = useMe();

  const next = [
    ...(admin
      ? [
          {
            href: href("settings", { page: "people" }),
            title: "Invite people",
            text: "Turn this into a team server. Each person gets their own setup.",
          },
        ]
      : []),
    {
      href: "#settings/push",
      title: "Reach it from your phone",
      text: "Notifications when Pi finishes or needs you.",
    },
    {
      href: href("settings", { page: "environments" }),
      title: "Add another machine",
      text: "A VM for heavier work, connected with one command.",
    },
  ];

  return (
    <>
      <Heading
        title={`You're set, ${user.name}`}
        description="Here's what Pi will use. Change any of it in Settings."
        centered
      />
      <ul className="grid gap-2.5 md:grid-cols-2">
        {steps.map((step) => (
          <Summary key={step.id} step={step} />
        ))}
      </ul>
      <div className="rounded-xl border border-line bg-elevated pt-2 shadow-xs">
        <NewSessionForm
          placeholder="What do you want to build first?"
          onStarted={onStarted}
        />
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-label text-fg-dim">When you're ready</h2>
        <ul className="grid gap-2.5 md:grid-cols-3">
          {next.map(({ href: link, title, text }) => (
            <li key={link}>
              <a
                href={link}
                onClick={onLeave}
                className={cn(
                  linkCardClass,
                  "flex h-full flex-col gap-1 p-3.5",
                )}
              >
                <span className="text-ui font-medium text-fg-strong">
                  {title}
                </span>
                <span className="text-label text-fg-dim">{text}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Summary({ step }: { readonly step: WizardStep }): ReactElement {
  const done = useDone(step);

  return (
    <li className={cn(cardClass, "flex items-center gap-3 p-3.5")}>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full",
          done === true ? "bg-done text-on-accent" : "border border-line",
        )}
      >
        {done === true && <Icon name="check" className="size-3.5" />}
      </span>
      <span className="flex flex-col">
        <span className="text-ui font-medium text-fg-strong">
          {step.step.title}
        </span>
        <span className="text-label text-fg-dim">
          {done === true ? "Set up" : "Skipped for now"}
        </span>
      </span>
    </li>
  );
}
