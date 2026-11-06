import type { Newcomers } from "@pipoca/protocol";
import { Button, cardClass, Chip, cn } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useQuery } from "../../data/hooks";
import { skippableSteps } from "../../setup/steps";
import { NewcomersForm } from "./newcomers-form";

const nothingSet: Newcomers = { template: null, profiles: [], required: [] };

export function useNewcomers(): Newcomers {
  return useQuery("settings.newcomers").data ?? nothingSet;
}

// Names for what an admin set up, in the words new people read.
function useNewcomerSummary(newcomers: Newcomers): {
  readonly template: string | undefined;
  readonly profiles: readonly string[];
  readonly required: readonly string[];
} {
  const templates = useQuery("environmentTemplates.list").data ?? [];
  const profiles = useQuery("profiles.list").data ?? [];
  const steps = skippableSteps();

  return {
    template: templates.find(({ id }) => id === newcomers.template)?.name,
    profiles: newcomers.profiles.flatMap(
      (id) => profiles.find((profile) => profile.id === id)?.name ?? [],
    ),
    required: newcomers.required.flatMap(
      (id) => steps.find((step) => step.id === id)?.title ?? [],
    ),
  };
}

// On People: what an admin set up so that new people only add what's
// theirs (ADR 0063).
export function NewcomersCard({
  editing,
  onEditing,
}: {
  readonly editing: boolean;
  readonly onEditing: (editing: boolean) => void;
}): ReactElement {
  const value = useNewcomers();
  const summary = useNewcomerSummary(value);

  const chips = [
    ...(summary.template === undefined ? [] : [summary.template]),
    summary.profiles.length === 0
      ? "Base Profile"
      : `Base Profile + ${summary.profiles.join(", ")}`,
    ...summary.required.map((title) => `Must do: ${title}`),
  ];

  return (
    <section
      aria-label="What new people get"
      className={cn(cardClass, "mt-6 flex flex-col gap-3 p-4")}
    >
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <h2 className="text-ui font-semibold text-fg-strong">
            What new people get
          </h2>
          <p className="text-label text-fg-dim">
            Their first-run setup skips what&apos;s set here, so they only add
            their own accounts.
          </p>
        </div>
        {!editing && (
          <Button
            onClick={() => {
              onEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <NewcomersForm
          saved={value}
          onDone={() => {
            onEditing(false);
          }}
        />
      ) : (
        <ul aria-label="New people get" className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li key={chip}>
              <Chip>{chip}</Chip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// In the invite dialog: what the people invited find ready, add and pick.
export function TheirSetup({
  onChange,
}: {
  readonly onChange: () => void;
}): ReactElement {
  const summary = useNewcomerSummary(useNewcomers());

  const ready = [
    ...(summary.template === undefined ? [] : [summary.template]),
    "the base Profile",
  ];

  return (
    <section
      aria-label="Their setup"
      className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-4"
    >
      <div className="flex items-center">
        <h3 className="flex-1 text-ui font-medium text-fg-strong">
          Their setup
        </h3>
        <Button variant="ghost" onClick={onChange}>
          Change
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5 text-label text-fg">
        <li>Ready for them: {ready.join(", ")}</li>
        {summary.required.length > 0 && (
          <li>They add: {summary.required.join(", ")} (required)</li>
        )}
        <li>
          They pick:{" "}
          {summary.profiles.length === 0
            ? "a Profile of their own"
            : `a Profile, from ${summary.profiles.join(", ")}, or their own`}
        </li>
      </ul>
    </section>
  );
}
