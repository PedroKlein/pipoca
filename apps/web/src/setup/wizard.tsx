import { Badge, cn, Hero, SetupShell, Spinner } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../data/client";
import { seed, useMe, useQuery } from "../data/hooks";
import { href, navigate } from "../router";
import { useNewcomers } from "../settings/people/newcomers";
import { PluginBoundary } from "../plugin-boundary";
import { DoneStep } from "./done-step";
import { FooterContext, type Footing, StepFooter } from "./footer";
import { type Phase, type WizardStep, useDone } from "./step";
import { personSteps, serverSteps } from "./steps";
import { WelcomeStep } from "./welcome-step";

type Screen =
  | { readonly kind: "step"; readonly step: WizardStep }
  | { readonly kind: "welcome" }
  | { readonly kind: "ready" };

const keyOf = (screen: Screen): string =>
  screen.kind === "step"
    ? `${screen.step.phase}:${screen.step.id}`
    : screen.kind;

const phaseOf = (screen: Screen | undefined): Phase =>
  screen?.kind === "step" ? screen.step.phase : "person";

const asScreen = (step: WizardStep): Screen => ({ kind: "step", step });

// A full-screen setup after the account step on the sign-in page (ADR 0063).
// An admin goes through the server's setup first, then their own like
// everyone else (ADR 0072). Every step shows, with Back, and what the team
// already answered comes preselected.
export function SetupWizard({
  start,
  onLeave,
}: {
  // The personal step a reminder on home opened.
  readonly start: string | undefined;
  readonly onLeave: () => void;
}): ReactElement {
  const { admin, solo: install, team: shared } = useMe();
  const setup = useQuery("me.setup").data;

  const server = useQuery("settings.serverSetup", undefined, {
    enabled: admin,
  }).data;

  const newcomers = useNewcomers();
  const [at, setAt] = useState<string>();

  // Unanswered, a server is for a team, as its first step preselects.
  const solo = admin && server?.usedBy === "me";
  const team = admin ? !solo : shared;
  const people = personSteps(solo);

  const screens: readonly Screen[] = [
    ...(admin ? serverSteps({ solo, install }).map(asScreen) : []),
    ...(team ? [{ kind: "welcome" } as const] : []),
    ...people.map(asScreen),
    { kind: "ready" },
  ];

  // A personal step by its id, or any step by its key, such as
  // server:git-hosts when a plugin's flow comes back to its server step.
  const opened = screens.find(
    (screen) =>
      screen.kind === "step" &&
      ((screen.step.phase === "person" && screen.step.id === start) ||
        keyOf(screen) === start),
  );

  const first =
    opened ??
    (setup?.serverPending === true
      ? screens[0]
      : screens.find((screen) => phaseOf(screen) === "person"));

  const current = at ?? (first === undefined ? undefined : keyOf(first));

  const index = Math.max(
    0,
    screens.findIndex((each) => keyOf(each) === current),
  );

  const screen = screens[index] ?? { kind: "ready" };
  const following = screens[index + 1];
  const phase = phaseOf(screen);
  const finishing = phase === "server" && phaseOf(following) === "person";

  // Finished even when the server can't save it, so no one is stuck here.
  const finish = (): void => {
    request("me.setup.update", { body: { finished: true } }).then(
      (saved) => {
        seed("me.setup", saved);
      },
      () => {
        seed("me.setup", {
          dismissed: setup?.dismissed ?? [],
          finished: true,
          serverPending: false,
        });
      },
    );
  };

  const leave = (): void => {
    navigate(href("home"));
    finish();
    onLeave();
  };

  const back =
    index === 0
      ? undefined
      : () => {
          setAt(keyOf(screens[index - 1] ?? screen));
        };

  const next = async (): Promise<void> => {
    // Server setup counts as finished once the admin moves on to their own.
    if (finishing && server?.finished === false) {
      seed(
        "settings.serverSetup",
        await request("settings.serverSetup.update", {
          body: { finished: true },
        }),
      );
    }

    if (following !== undefined) {
      setAt(keyOf(following));
    }
  };

  // Each setup counts its own steps; Welcome and Ready stand outside them.
  const counted = screens.filter(
    (each) => each.kind === "step" && each.step.phase === phase,
  );

  const position = counted.indexOf(screen);

  if (admin && server === undefined) {
    return (
      <SetupShell>
        <main className="mx-auto pt-16">
          <Spinner label="Loading…" />
        </main>
      </SetupShell>
    );
  }

  const footing: Omit<Footing, "done" | "skippable"> = {
    back,
    next,
    label: labelOf(screen, finishing),
  };

  return (
    <SetupShell
      label={
        <Badge>{phase === "server" ? "Server setup" : "Your setup"}</Badge>
      }
      {...(position !== -1 && {
        steps: { total: counted.length, at: position },
        aside: `Step ${String(position + 1)} of ${String(counted.length)}`,
      })}
    >
      <main
        className={cn(
          "mx-auto flex w-full animate-rise-in flex-col gap-8 px-4 pt-8 pb-16 md:pt-11",
          screen.kind === "step" && screen.step.step.wide === true
            ? "max-w-198"
            : "max-w-158",
        )}
      >
        {screen.kind === "step" && (
          <CurrentStep
            key={keyOf(screen)}
            step={screen.step}
            solo={solo}
            footing={{
              ...footing,
              skippable:
                screen.step.step.optional === true &&
                !(
                  screen.step.phase === "person" &&
                  newcomers.required.includes(screen.step.id)
                ),
            }}
          />
        )}
        {screen.kind === "welcome" && (
          <FooterContext value={{ ...footing, done: true, skippable: false }}>
            <WelcomeStep steps={people} />
          </FooterContext>
        )}
        {screen.kind === "ready" && (
          <DoneStep
            steps={people}
            onBack={back}
            onStarted={() => {
              finish();
              onLeave();
            }}
            onLeave={leave}
          />
        )}
      </main>
    </SetupShell>
  );
}

function labelOf(screen: Screen, finishing: boolean): string {
  if (finishing) {
    return "Finish and set up my account";
  }

  return screen.kind === "welcome" ? "Start" : "Continue";
}

function CurrentStep({
  step,
  solo,
  footing,
}: {
  readonly step: WizardStep;
  readonly solo: boolean;
  readonly footing: Omit<Footing, "done">;
}): ReactElement {
  const done = useDone(step);
  const { id, step: about } = step;

  return (
    <>
      <Hero title={about.heading}>{about.description}</Hero>
      <FooterContext value={{ ...footing, done }}>
        <PluginBoundary name={id}>
          <about.Step solo={solo} />
        </PluginBoundary>
        {about.ownFooter !== true && <StepFooter />}
      </FooterContext>
    </>
  );
}
