import type { SetupStep } from "@pipoca/plugins/web";
import { api } from "../api";
import { enabledPlugins, pluginContext } from "../plugins";
import { type WizardStep, connected, hasContent } from "./step";
import { ProfileStepPage } from "./offered-profiles";
import { WhereStep } from "./where-step";

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

// The kernel's steps around the ones plugins add, such as a model and code
// hosts (ADR 0063). The steps people can't skip come first.
export function setupSteps(): readonly WizardStep[] {
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
