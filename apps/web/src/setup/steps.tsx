import type {
  PersonSetupStepId,
  ServerSetupStepId,
  SetupStep,
} from "@pipoca/plugins/web";
import { request } from "../data/client";
import { enabledPlugins } from "../plugins";
import {
  type Phase,
  type StepAbout,
  type WizardStep,
  connected,
  hasContent,
} from "./step";
import { ProfileStepPage } from "./offered-profiles";
import { WhereStep } from "./where-step";
import { WhoStep } from "./server/who-step";
import { PluginsStep } from "./server/plugins-step";
import { BaseProfileStep, baseProfileDone } from "./server/base-profile-step";
import { ServerWhereStep } from "./server/where-step";
import { NewcomersStep } from "./server/newcomers-step";

const always = async (): Promise<boolean> => Promise.resolve(true);

const serverKernel: Readonly<Record<ServerSetupStepId, StepAbout>> = {
  who: {
    title: "Who it is for",
    summary: "Just me or a team",
    heading: "Who is this Pipoca for?",
    description:
      "This decides what we ask next. You can open it to a team later from Settings, People.",
    done: async () => (await request("settings.serverSetup")).usedBy !== null,
    topics: ["server-setup"],
    ownFooter: true,
    Step: WhoStep,
  },
  plugins: {
    title: "Plugins",
    summary: "What the server does",
    heading: "What should this server do?",
    description:
      "Everything past the basics is a plugin. Turn on what the team needs; plugins with something to set up add their own step after this one. You can change this later in Settings, Plugins.",
    wide: true,
    done: always,
    Step: PluginsStep,
  },
  "default-profile": {
    title: "Server default Profile",
    summary: "Packages and instructions under every Session",
    heading: "Server default Profile",
    description:
      "It sits under every Session on this server, personal and team, below each person's own default Profile. Add packages everyone needs, including ones that add model providers, so every model picker lists them.",
    wide: true,
    optional: true,
    done: baseProfileDone,
    topics: ["profiles"],
    Step: BaseProfileStep,
  },
  where: {
    title: "Where Sessions run",
    summary: "Templates and team machines",
    heading: "Where do Sessions run?",
    description:
      "Pick any that apply. People choose between them when they start a Session.",
    done: always,
    Step: ServerWhereStep,
  },
  newcomers: {
    title: "New people",
    summary: "Their steps and invites",
    heading: "What new people get",
    description:
      "This is what someone sees the first time they sign in. Anything you've already answered for them is shown as done.",
    wide: true,
    done: always,
    ownFooter: true,
    Step: NewcomersStep,
  },
};

const personKernel: Readonly<
  Record<Exclude<PersonSetupStepId, "welcome">, StepAbout>
> = {
  where: {
    title: "Where Pi works",
    summary: "This computer, another machine or a cluster",
    heading: "Where should Pi work?",
    description:
      "Each place becomes an Environment, and you choose between them when you start a Session.",
    done: async () => (await request("environments.list")).some(connected),
    topics: ["environments"],
    ownFooter: true,
    Step: WhereStep,
  },
  profile: {
    title: "Your default Profile",
    summary: "Copy a team Profile, bring your ~/.pi/agent or use Pi's defaults",
    heading: "Make Pi yours",
    description:
      "This sets up your default Profile: the instructions, skills and tools all your personal Sessions get, on top of the server's default. Team Sessions use team Profiles instead.",
    optional: true,
    // Pi's defaults is an answer too, kept as the step's reminder put away.
    done: async () => {
      const [profiles, setup] = await Promise.all([
        request("profiles.list"),
        request("me.setup"),
      ]);

      return (
        setup.dismissed.includes("profile") ||
        profiles.some(
          (profile) =>
            profile.ownerId !== null &&
            (hasContent(profile) || profile.buildsOn !== null),
        )
      );
    },
    topics: ["profiles", "setup"],
    ownFooter: true,
    Step: ProfileStepPage,
  },
};

const serverOrder = [
  "who",
  "plugins",
  "default-profile",
  "where",
  "newcomers",
] as const satisfies readonly ServerSetupStepId[];

const personOrder = [
  "welcome",
  "where",
  "profile",
] as const satisfies readonly PersonSetupStepId[];

interface Added extends WizardStep {
  readonly after: string;
}

// Each plugin adds at most one step to each setup. One without an
// audience is a personal one, as every step was before ADR 0072.
function added(phase: Phase, solo: boolean): readonly Added[] {
  const order: readonly string[] =
    phase === "server" ? serverOrder : personOrder;

  return enabledPlugins().flatMap(({ plugin, setup = [] }) => {
    const ofPhase = (step: SetupStep): boolean =>
      (step.audience === "server") === (phase === "server");

    const step = setup.find(ofPhase);

    // On a server just for its person, a plugin's personal step sets up
    // what its server step would have.
    if (
      step === undefined ||
      (phase === "server" && solo && setup.some((each) => !ofPhase(each)))
    ) {
      return [];
    }

    const after =
      step.after !== undefined && order.includes(step.after)
        ? step.after
        : order[phase === "server" ? 1 : 0];

    return [{ id: plugin.id, phase, step, after: after ?? "" }];
  });
}

function ordered(
  phase: Phase,
  order: readonly string[],
  kernel: ReadonlyMap<string, StepAbout>,
  solo: boolean,
): readonly WizardStep[] {
  const plugins = added(phase, solo);

  return order.flatMap((anchor) => {
    const own = kernel.get(anchor);

    return [
      ...(own === undefined ? [] : [{ id: anchor, phase, step: own }]),
      ...plugins.filter(({ after }) => after === anchor),
    ];
  });
}

// What an admin sets for the whole server (ADR 0072). A solo install never
// asks who it is for, and a server just for its person has no team to set
// up where Sessions run or what new people get.
export function serverSteps({
  solo,
  install,
}: {
  readonly solo: boolean;
  readonly install: boolean;
}): readonly WizardStep[] {
  const shown = serverOrder.filter(
    (id) =>
      !(id === "who" && install) &&
      !(solo && (id === "where" || id === "newcomers")),
  );

  return ordered(
    "server",
    serverOrder,
    new Map(shown.map((id) => [id, serverKernel[id]])),
    solo,
  );
}

// The steps each person does, admins too, between Welcome and Ready.
export function personSteps(solo = false): readonly WizardStep[] {
  return ordered(
    "person",
    personOrder,
    new Map(Object.entries(personKernel)),
    solo,
  );
}

// The steps people may skip, which admins can make new people do.
export function skippableSteps(): readonly {
  readonly id: string;
  readonly title: string;
}[] {
  return personSteps().flatMap(({ id, step }) =>
    step.optional === true ? [{ id, title: step.title }] : [],
  );
}
