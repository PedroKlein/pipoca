import type { Newcomers, Profile } from "@pipoca/protocol";
import { Button, Checkbox, ErrorText, Select } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../../api";
import { useProfiles, useTemplates } from "../../hooks";
import { skippableSteps } from "../../setup/steps";

export function NewcomersForm({
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

        api("settings.newcomers.update", { body: draft }).then(
          onDone,
          (reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
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
          <Checkbox
            key={profile.id}
            label={profile.name}
            checked={draft.profiles.includes(profile.id)}
            onChange={() => {
              setDraft({
                ...draft,
                profiles: toggled(draft.profiles, profile.id),
              });
            }}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-label font-medium text-fg">
          Steps they can&apos;t skip
        </legend>
        {steps.map((step) => (
          <Checkbox
            key={step.id}
            label={step.title}
            checked={draft.required.includes(step.id)}
            onChange={() => {
              setDraft({
                ...draft,
                required: toggled(draft.required, step.id),
              });
            }}
          />
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
