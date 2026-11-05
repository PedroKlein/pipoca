import { json, useLoaded } from "@pipoca/plugins/web";
import type { Newcomers, Profile } from "@pipoca/protocol";
import { Button, ErrorText, Select } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { send } from "./api";
import { useProfiles, useTemplates } from "./hooks";
import { skippableSteps } from "./setup";

const nothingSet: Newcomers = { template: null, profiles: [], required: [] };

export function useNewcomers(): {
  readonly value: Newcomers;
  readonly reload: () => void;
} {
  const { value, reload } = useLoaded(
    async () => json<Newcomers>(fetch("/api/newcomers")),
    "newcomers",
    { topics: ["newcomers"] },
  );

  return { value: value ?? nothingSet, reload };
}

// Names for what an admin set up, in the words new people read.
export function useNewcomerSummary(newcomers: Newcomers): {
  readonly template: string | undefined;
  readonly profiles: readonly string[];
  readonly required: readonly string[];
} {
  const templates = useTemplates().value;
  const profiles = useProfiles().value;
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
  const { value, reload } = useNewcomers();
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
      className="mt-6 flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 shadow-xs"
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
            reload();
          }}
        />
      ) : (
        <ul aria-label="New people get" className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li
              key={chip}
              className="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-label text-fg"
            >
              {chip}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewcomersForm({
  saved,
  onDone,
}: {
  readonly saved: Newcomers;
  readonly onDone: () => void;
}): ReactElement {
  const templates = useTemplates().value;

  const shared = useProfiles().value.filter(
    (profile: Profile) => profile.ownerId === null,
  );

  const steps = skippableSteps();
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string>();

  const toggled = (list: readonly string[], id: string): readonly string[] =>
    list.includes(id) ? list.filter((each) => each !== id) : [...list, id];

  return (
    <form
      aria-label="Choose what new people get"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();

        send("/api/newcomers", "PUT", draft).then(onDone, (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-label font-medium text-fg">
          An Environment from
        </span>
        <Select
          value={draft.template ?? ""}
          onChange={(event) => {
            setDraft({
              ...draft,
              template: event.target.value === "" ? null : event.target.value,
            });
          }}
        >
          <option value="">No template: they set one up</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-label font-medium text-fg">
          Profiles they pick from
        </legend>
        {shared.length === 0 && (
          <span className="text-label text-fg-dim">
            No shared Profiles yet. Make one on Profiles.
          </span>
        )}
        {shared.map((profile) => (
          <label key={profile.id} className="flex items-center gap-2 text-ui">
            <input
              type="checkbox"
              checked={draft.profiles.includes(profile.id)}
              onChange={() => {
                setDraft({
                  ...draft,
                  profiles: toggled(draft.profiles, profile.id),
                });
              }}
            />
            {profile.name}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-label font-medium text-fg">
          Steps they can&apos;t skip
        </legend>
        {steps.map((step) => (
          <label key={step.id} className="flex items-center gap-2 text-ui">
            <input
              type="checkbox"
              checked={draft.required.includes(step.id)}
              onChange={() => {
                setDraft({
                  ...draft,
                  required: toggled(draft.required, step.id),
                });
              }}
            />
            {step.title}
          </label>
        ))}
      </fieldset>
      <ErrorText size="caption">{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}

// In the invite dialog: what the people invited find ready, add and pick.
export function TheirSetup({
  onChange,
}: {
  readonly onChange: () => void;
}): ReactElement {
  const summary = useNewcomerSummary(useNewcomers().value);

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
