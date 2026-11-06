import type { Profile, ProfileContent } from "@pipoca/protocol";
import {
  Button,
  cardClass,
  cn,
  Icon,
  ListInput,
  Picker,
  Section,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../../data/client";
import { useAction, useQuery } from "../../data/hooks";
import { href } from "../../router";
import {
  packageText,
  packageOf,
  layerHashes,
  type Layer,
  layerRoutes,
  layerNames,
  chipClass,
  layerAbout,
} from "./layers";

// What a Profile builds on, from the bottom: the base, the person's My
// defaults and, if they pick one, another Profile (ADR 0063).
export function BuildsOn({
  profile,
  profiles,
  value,
  team,
  disabled = false,
  onChange,
}: {
  readonly profile: Profile | undefined;
  readonly profiles: readonly Profile[];
  readonly value: string | null;
  readonly team: boolean;
  readonly disabled?: boolean;
  readonly onChange: (id: string | null) => void;
}): ReactElement {
  const shared = profile?.ownerId === null;

  const options = profiles.filter(
    ({ id, ownerId }) => id !== profile?.id && (!shared || ownerId === null),
  );

  const step = <Icon name="chevron-right" className="size-3.5 text-fg-dim" />;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-label">
      <span className="mr-1 text-fg-dim">Builds on</span>
      <a
        href={href("settings", { page: "profiles", rest: layerHashes.base })}
        className={chipClass}
      >
        {layerNames.base}
      </a>
      {step}
      {!team && (
        <>
          <a
            href={href("settings", {
              page: "profiles",
              rest: layerHashes.defaults,
            })}
            className={chipClass}
          >
            {layerNames.defaults}
          </a>
          {step}
        </>
      )}
      {disabled ? (
        <span className={chipClass}>
          {profiles.find(({ id }) => id === value)?.name ?? "Nothing else"}
        </span>
      ) : (
        <Picker
          label="Builds on"
          options={[
            { value: "", label: "Nothing else" },
            ...options.map(({ id, name }) => ({ value: id, label: name })),
          ]}
          selected={[value ?? ""]}
          onChange={([id]) => {
            onChange(id === undefined || id === "" ? null : id);
          }}
        >
          {profiles.find(({ id }) => id === value)?.name ?? "Nothing else"}
        </Picker>
      )}
    </div>
  );
}

export function LayerEditor({
  layer,
}: {
  readonly layer: Layer;
}): ReactElement | null {
  const content = useQuery(layerRoutes[layer]).data;

  // The form starts again when the layer changes, so it doesn't keep this.
  const [saved, setSaved] = useState(false);

  return content ? (
    <LayerForm
      key={JSON.stringify(content.packages)}
      layer={layer}
      content={content}
      saved={saved}
      onSaved={() => {
        setSaved(true);
      }}
    />
  ) : null;
}

function LayerForm({
  layer,
  content,
  saved,
  onSaved,
}: {
  readonly layer: Layer;
  readonly content: ProfileContent;
  readonly saved: boolean;
  readonly onSaved: () => void;
}): ReactElement {
  const [packages, setPackages] = useState<readonly string[]>(() =>
    content.packages.map(packageText),
  );

  const save = useAction(async () => {
    await request(`${layerRoutes[layer]}.update`, {
      body: { packages: packages.map(packageOf) },
    });

    onSaved();
  });

  const error = save.error;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.run();
  };

  return (
    <Section title={layerNames[layer]}>
      <form
        onSubmit={submit}
        className={cn(cardClass, "flex flex-col gap-4 p-5")}
      >
        <p className="text-caption text-fg-dim">{layerAbout[layer]}</p>
        <ListInput
          label="Pi packages"
          values={packages}
          placeholder="npm:pi-subagents, git:… or a path, then Enter"
          onChange={setPackages}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit">
            Save
          </Button>
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
    </Section>
  );
}
