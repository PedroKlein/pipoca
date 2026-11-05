import {
  type SetupStep,
  useLoaded,
  type WebContext,
} from "@pipoca/plugins/web";
import type { Environment, Profile, SetupState } from "@pipoca/protocol";
import {
  Badge,
  Button,
  cardClass,
  ChoiceCard,
  cn,
  Command,
  ErrorText,
  Hero,
  Icon,
  linkCardClass,
  Row,
  Rows,
  SetupShell,
  Spinner,
  Step,
  Stepper,
  type StepState,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  useEnvironments,
  useProfiles,
  useSessions,
  useTemplates,
} from "./hooks";
import { useNewcomers } from "./settings/people/newcomers";
import { NewSessionForm } from "./new-session";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";
import { ProfileStep } from "./setup-profile";

interface Step {
  readonly id: string;
  readonly step: SetupStep;
  readonly context: WebContext;
}

const connected = ({ online, onDemand }: Environment): boolean =>
  online || onDemand;

function hasContent(profile: Profile): boolean {
  return (
    profile.agentsMd !== "" ||
    profile.packages.length > 0 ||
    Object.keys(profile.mcpServers).length > 0
  );
}

const whereStep: SetupStep = {
  title: "Where Pi works",
  summary: "This computer, another machine or a cluster",
  heading: "Where should Pi work?",
  description:
    "Each place becomes an Environment, and you choose between them when you start a Session.",
  done: async () => (await api("environments.list")).some(connected),
  topics: ["environments"],
  Step: WhereStep,
};

const profileStep: SetupStep = {
  title: "Your Profile",
  summary: "Bring your ~/.pi/agent or start fresh",
  heading: "Make Pi yours",
  description:
    "A Profile is how Pi behaves: its instructions, skills, extensions and tools. Every Session runs with one.",
  optional: true,
  done: async () =>
    (await api("profiles.list")).some(
      (profile) =>
        hasContent(profile) ||
        (profile.ownerId !== null && profile.buildsOn !== null),
    ),
  topics: ["profiles"],
  Step: ProfileStepPage,
};

function ProfileStepPage(): ReactElement {
  const profiles = useProfiles();

  const offered = useNewcomers().value.profiles.flatMap(
    (id) => profiles.value.find((profile) => profile.id === id) ?? [],
  );

  return (
    <>
      {offered.length > 0 && (
        <OfferedProfiles
          offered={offered}
          profiles={profiles.value}
          onChange={profiles.reload}
        />
      )}
      <ProfileStep profiles={profiles.value} onImported={profiles.reload} />
    </>
  );
}

// The shared Profiles an admin offers new people. Each one picked becomes a
// Profile of theirs that builds on it (ADR 0063).
function OfferedProfiles({
  offered,
  profiles,
  onChange,
}: {
  readonly offered: readonly Profile[];
  readonly profiles: readonly Profile[];
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-label text-fg-dim">
        Pick any. Each one becomes a Profile of yours, and you can switch per
        Session.
      </p>
      <ul aria-label="Profiles on offer" className="flex flex-col gap-2.5">
        {offered.map((shared) => {
          const mine = profiles.find(
            ({ ownerId, buildsOn }) =>
              ownerId !== null && buildsOn === shared.id,
          );

          return (
            <ChoiceCard
              type="checkbox"
              as="li"
              key={shared.id}
              title={shared.name}
              description={offeredDescription(shared)}
              checked={mine !== undefined}
              onChange={(checked) => {
                const change =
                  checked || mine === undefined
                    ? api("profiles.create", {
                        body: { name: shared.name, buildsOn: shared.id },
                      })
                    : api("profiles.remove", { params: { id: mine.id } });

                change.then(onChange, failed);
              }}
            />
          );
        })}
      </ul>
      <ErrorText size="caption">{error}</ErrorText>
      <p className="pt-2 text-label font-medium text-fg">Or bring your own</p>
    </div>
  );
}

function offeredDescription(profile: Profile): string {
  const first = profile.agentsMd
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "");

  return first ?? "A Profile your team shares";
}

// The kernel's steps around the ones plugins add, such as a model and code
// hosts (ADR 0063). The steps people can't skip come first.
function setupSteps(): readonly Step[] {
  const kernel = pluginContext("setup");

  const added = enabledPlugins().flatMap(({ name, setupStep }) =>
    setupStep
      ? [{ id: name, step: setupStep, context: pluginContext(name) }]
      : [],
  );

  return [
    { id: "where", step: whereStep, context: kernel },
    ...added.filter(({ step }) => step.optional !== true),
    ...added.filter(({ step }) => step.optional === true),
    { id: "profile", step: profileStep, context: kernel },
  ];
}

// The steps people may skip, which admins can make new people do.
export function skippableSteps(): readonly {
  readonly id: string;
  readonly title: string;
}[] {
  return setupSteps().flatMap(({ id, step }) =>
    step.optional === true ? [{ id, title: step.title }] : [],
  );
}

// Runners come online and report models without a topic, so a step that
// isn't done yet looks again every few seconds.
function useDone({ id, step, context }: Step): boolean | undefined {
  const [waiting, setWaiting] = useState(true);

  const { value } = useLoaded(async () => step.done(context), `setup ${id}`, {
    topics: step.topics ?? [],
    ...(waiting && { everyMs: 2000 }),
  });

  if (waiting !== (value !== true)) {
    setWaiting(value !== true);
  }

  return value;
}

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
          <button
            type="button"
            onClick={leave}
            className="cursor-pointer hover:text-fg"
          >
            Done
          </button>
        ) : (
          `Step ${String(at + 2)} of ${String(total)}`
        )
      }
    >
      <div
        className={cn(
          !admin &&
            "mx-auto flex w-full max-w-260 flex-col gap-6 px-4 md:flex-row md:gap-14",
        )}
      >
        {!admin && <JoinSteps user={user} steps={steps} at={at} />}
        <main
          className={cn(
            "mx-auto flex w-full animate-rise-in flex-col gap-8 px-4 pt-8 pb-16 md:pt-11",
            step === undefined || step.step.wide === true
              ? "max-w-chat"
              : "max-w-150",
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
  readonly steps: readonly Step[];
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

function Heading({
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
  readonly step: Step;
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

function WhereStep(): ReactElement {
  const environments = useEnvironments().value;
  const ready = environments.filter(connected);
  const [machine, setMachine] = useState(ready.length === 0);
  const [error, setError] = useState<string>();

  const templates = useTemplates().value;

  // Pod templates the person has no Environment from yet.
  const clusters = templates.filter(
    ({ id, runnersFrom }) =>
      runnersFrom === "kubernetes" &&
      !environments.some(({ templateId }) => templateId === id),
  );

  return (
    <ul className="flex flex-col gap-2.5">
      {ready.map((environment) => (
        <ChoiceCard
          type="checkbox"
          as="li"
          key={environment.id}
          title={environment.name}
          badge={<Badge state="done">Ready</Badge>}
          description={
            environment.onDemand
              ? "Runners start when a Session needs one."
              : "Sessions work in folders on this machine, with its own tools and git setup."
          }
          checked
        >
          {environment.folders.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-label font-medium text-fg">
                Pi may work in any folder inside
              </span>
              <span className="flex flex-wrap gap-1.5">
                {environment.folders.map((folder) => (
                  <span
                    key={folder}
                    className="inline-flex h-7 items-center rounded-full border border-line px-2.5 font-mono text-mono-sm text-fg"
                  >
                    {folder}
                  </span>
                ))}
              </span>
            </div>
          )}
        </ChoiceCard>
      ))}
      {clusters.map((template) => (
        <ChoiceCard
          type="checkbox"
          as="li"
          key={template.id}
          title="A Kubernetes cluster"
          badge={<Badge state="offline">{template.name}</Badge>}
          description="Each Session gets its own pod, started when it needs one."
          checked={false}
          onChange={() => {
            api("environments.create", {
              body: { name: template.name, template: template.id },
            }).catch((reason: unknown) => {
              setError(`Couldn't add it. ${String(reason)}`);
            });
          }}
        />
      ))}
      <ErrorText size="caption">{error}</ErrorText>
      <ChoiceCard
        type="checkbox"
        as="li"
        title="Another machine"
        description="A Linux VM, a workstation or a second laptop. Run one command on it."
        checked={machine}
        onChange={setMachine}
      >
        <ConnectMachine />
      </ChoiceCard>
    </ul>
  );
}

function ConnectMachine(): ReactElement {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();

  if (key === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            api("joinKeys.create")
              .then(({ key: made }) => {
                setKey(made);
              })
              .catch((reason: unknown) => {
                setError(`Couldn't make a key. ${String(reason)}`);
              });
          }}
        >
          Show the command
        </Button>
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    );
  }

  const command = `PIPOCA_KEY=${key} pipoca agent --server ${location.origin}`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-fg-dim">
        Run it in the folder Pi should work in. The key is shown only now.
      </p>
      <Command label="Join command">{command}</Command>
      <p aria-live="polite">
        <Spinner label="Waiting for the machine to connect…" />
      </p>
    </div>
  );
}

function DoneStep({
  user,
  admin,
  steps,
  onStarted,
  onLeave,
}: {
  readonly user: string;
  readonly admin: boolean;
  readonly steps: readonly Step[];
  readonly onStarted: () => void;
  readonly onLeave: () => void;
}): ReactElement {
  const environments = useEnvironments().value;
  const profiles = useProfiles().value;
  const sessions = useSessions(false).value;

  const next = [
    ...(admin
      ? [
          {
            href: "#people",
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
      href: "#environments",
      title: "Add another machine",
      text: "A VM for heavier work, connected with one command.",
    },
  ];

  return (
    <>
      <Heading
        title={`You're set, ${user}`}
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
          environments={environments}
          profiles={profiles}
          sessions={sessions}
          placeholder="What do you want to build first?"
          onStarted={onStarted}
        />
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-label text-fg-dim">When you're ready</h2>
        <ul className="grid gap-2.5 md:grid-cols-3">
          {next.map(({ href, title, text }) => (
            <li key={href}>
              <a
                href={href}
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

function Summary({ step }: { readonly step: Step }): ReactElement {
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

// The steps someone skipped, or never did before the setup existed, stay on
// home until they're done or dismissed (ADR 0063).
export function SetupReminders({
  setup,
  onDismiss,
}: {
  readonly setup: SetupState;
  readonly onDismiss: (step: string) => void;
}): ReactElement {
  return (
    <section
      aria-label="Finish setting up"
      className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-1.5 px-4 not-has-[li]:hidden"
    >
      <h2 className="text-label font-medium text-fg-dim">Finish setting up</h2>
      <Rows>
        {setupSteps()
          .filter(({ id }) => !setup.dismissed.includes(id))
          .map((step) => (
            <Reminder
              key={step.id}
              step={step}
              onDismiss={() => {
                void api("me.setup.update", {
                  body: { dismiss: step.id },
                }).then(() => {
                  onDismiss(step.id);
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
  readonly step: Step;
  readonly onDismiss: () => void;
}): ReactElement | null {
  const done = useDone(step);

  if (done !== false) {
    return null;
  }

  return (
    <Row title={step.step.heading} description={step.step.summary}>
      <a
        href={`#get-started/${step.id}`}
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
