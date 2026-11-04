import {
  json,
  type SetupStep,
  useLoaded,
  type WebContext,
} from "@pipoca/plugins/web";
import type { Environment, Profile, SetupState } from "@pipoca/protocol";
import { Badge, Button, cn, Icon, Row, Rows } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { api } from "./api";
import {
  useEnvironments,
  useProfiles,
  useSessions,
  useTemplates,
} from "./hooks";
import { Mark } from "./mark";
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
  done: async () =>
    (await json<Environment[]>(fetch("/api/environments"))).some(connected),
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
    (await json<Profile[]>(fetch("/api/profiles"))).some(hasContent),
  topics: ["profiles"],
  Step: ProfileStepPage,
};

function ProfileStepPage(): ReactElement {
  const profiles = useProfiles();

  return <ProfileStep profiles={profiles.value} onImported={profiles.reload} />;
}

// The kernel's steps around the ones plugins add, such as a model and code
// hosts (ADR 0063).
function setupSteps(): readonly Step[] {
  const kernel = pluginContext("setup");

  return [
    { id: "where", step: whereStep, context: kernel },
    ...enabledPlugins().flatMap(({ name, setupStep }) =>
      setupStep
        ? [{ id: name, step: setupStep, context: pluginContext(name) }]
        : [],
    ),
    { id: "profile", step: profileStep, context: kernel },
  ];
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

  const first = Math.max(
    0,
    steps.findIndex(({ id }) => id === start),
  );

  const [at, setAt] = useState(first);
  const step = steps[at];
  const total = steps.length + 2;

  const finish = (): void => {
    void api("/api/setup", { finished: true }).finally(onFinish);
  };

  const leave = (): void => {
    location.hash = "";
    finish();
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg font-sans text-ui text-fg">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-7 py-5">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-7" />
          pipoca
        </span>
        <ol aria-label="Setup steps" className="flex gap-1.5">
          {Array.from({ length: total }, (_, index) => (
            <li
              key={index}
              aria-current={index === at + 1 ? "step" : undefined}
              className={cn(
                "h-0.75 w-9 rounded-full",
                index <= at + 1 ? "bg-fg-strong" : "bg-line",
              )}
            />
          ))}
        </ol>
        <span className="justify-self-end text-label text-fg-dim">
          {step === undefined ? (
            <button
              type="button"
              onClick={leave}
              className="cursor-pointer hover:text-fg"
            >
              Done
            </button>
          ) : (
            `Step ${String(at + 2)} of ${String(total)}`
          )}
        </span>
      </header>
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
  );
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
    <div className={cn("flex flex-col gap-2", centered && "text-center")}>
      <h1 className="font-serif text-hero leading-tight font-light text-fg-strong">
        {title}
      </h1>
      <p className="max-w-chat text-prose text-fg-dim">{description}</p>
    </div>
  );
}

function CurrentStep({
  step,
  onBack,
  onNext,
}: {
  readonly step: Step;
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
        {about.optional === true && done !== true && (
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
        <Choice
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
        </Choice>
      ))}
      {clusters.map((template) => (
        <Choice
          key={template.id}
          title="A Kubernetes cluster"
          badge={<Badge state="offline">{template.name}</Badge>}
          description="Each Session gets its own pod, started when it needs one."
          checked={false}
          onChange={() => {
            api("/api/environments", {
              name: template.name,
              template: template.id,
            }).catch((reason: unknown) => {
              setError(`Couldn't add it. ${String(reason)}`);
            });
          }}
        />
      ))}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
      <Choice
        title="Another machine"
        description="A Linux VM, a workstation or a second laptop. Run one command on it."
        checked={machine}
        onChange={setMachine}
      >
        <ConnectMachine />
      </Choice>
    </ul>
  );
}

function Choice({
  title,
  badge,
  description,
  checked,
  onChange,
  children,
}: {
  readonly title: string;
  readonly badge?: ReactNode;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4",
        checked && "border-fg-strong shadow-xs",
      )}
    >
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={onChange === undefined}
          onChange={(event) => {
            onChange?.(event.target.checked);
          }}
          className="mt-1 size-4 accent-(--accent)"
        />
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-ui font-medium text-fg-strong">
            {title}
            {badge}
          </span>
          <span className="text-label text-fg-dim">{description}</span>
        </span>
      </label>
      {checked && children !== undefined && (
        <div className="pl-7">{children}</div>
      )}
    </li>
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
            api("/api/join-key", {})
              .then(async (response) => {
                setKey(((await response.json()) as { key: string }).key);
              })
              .catch((reason: unknown) => {
                setError(`Couldn't make a key. ${String(reason)}`);
              });
          }}
        >
          Show the command
        </Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    );
  }

  const command = `PIPOCA_KEY=${key} pipoca agent --server ${location.origin}`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-fg-dim">
        Run it in the folder Pi should work in. The key is shown only now.
      </p>
      <div className="flex items-start gap-2">
        <pre
          aria-label="Join command"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel p-3 font-mono text-mono-sm break-all whitespace-pre-wrap"
        >
          {command}
        </pre>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(command);
          }}
        >
          Copy
        </Button>
      </div>
      <p className="text-caption text-fg-dim" aria-live="polite">
        Waiting for the machine to connect…
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
                className="flex h-full flex-col gap-1 rounded-lg border border-line bg-elevated p-3.5 hover:border-line-strong"
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
    <li className="flex items-center gap-3 rounded-lg border border-line bg-elevated p-3.5">
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
                void api("/api/setup", { dismiss: step.id }).then(() => {
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
