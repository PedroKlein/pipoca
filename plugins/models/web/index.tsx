import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import type { Environment, ModelRef } from "@pipoca/protocol";
import { Badge, Button, cn, ErrorText, fieldClass, Icon, initialsOf, PageTitle, Row, Rows, Section, Select } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import {
  aliasesOf,
  gatewayProvider,
  modelKey,
  unhealthy,
} from "../src/gateway";
import {
  type AliasConfig,
  type EnvironmentModels,
  type Health,
  modelRef,
  modelValue,
  noHealth,
  type ProviderSettings,
  thinkingLevels,
} from "../src/model";

const schedules = ["", "utc-hourly", "utc-midnight", "utc-monthly-1st"];

export const models: WebPlugin = {
  name: "models",
  SettingsSection: Page,
  settingsGroup: "workspace",
};

function Page({ context }: { readonly context: WebContext }): ReactElement {
  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        json<Environment[]>(context.request("/api/environments")),
        json<EnvironmentModels[]>(context.request("environments")),
      ]),
    "models",
  );

  const [environments, configs] = value ?? [[], []];
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState(false);

  const environment =
    environments.find(({ id }) => id === chosen) ?? environments[0];

  return (
    <>
      <PageTitle
        description='Name a choice once, like "smart" or "fast", and list models to try in order. If one is down or out of quota, the next one answers.'
        actions={
          environment !== undefined &&
          !adding && (
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              <Icon name="plus" />
              New alias
            </Button>
          )
        }
      >
        Models
      </PageTitle>
      {value !== undefined && environment === undefined && (
        <Rows>
          <Row
            title="No Environments yet"
            description="Aliases belong to an Environment. Add one under Environments first."
          />
        </Rows>
      )}
      {environments.length > 1 && environment !== undefined && (
        <label className="mt-6 flex flex-wrap items-center gap-3 text-label text-fg-dim">
          Aliases of
          <Select
            value={environment.id}
            onChange={(event) => {
              setChosen(event.target.value);
              setAdding(false);
            }}
          >
            {environments.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {environment !== undefined && (
        <Aliases
          key={environment.id}
          context={context}
          environment={environment}
          saved={configs.find(
            ({ environmentId }) => environmentId === environment.id,
          )}
          adding={adding}
          onAdding={setAdding}
          onSaved={reload}
        />
      )}
      {environment !== undefined && (
        <InThePicker context={context} environment={environment} />
      )}
    </>
  );
}

interface HiddenModels {
  readonly hidden: readonly string[];
  readonly mayChange: boolean;
}

// Admins hide the models nobody here should use from every model picker.
function InThePicker({
  context,
  environment,
}: {
  readonly context: WebContext;
  readonly environment: Environment;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<HiddenModels>(context.request("hidden")),
    "models.hidden",
  );

  const [choosing, setChoosing] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<readonly string[]>();

  if (value?.mayChange !== true) {
    return null;
  }

  const hidden = saving ?? value.hidden;

  const byProvider = new Map<string, ModelRef[]>();

  for (const model of environment.models) {
    if (model.provider !== gatewayProvider) {
      byProvider.set(model.provider, [
        ...(byProvider.get(model.provider) ?? []),
        model,
      ]);
    }
  }

  if (byProvider.size === 0) {
    return null;
  }

  const save = (next: readonly string[]): void => {
    setSaving(next);

    json(
      context.request("hidden", {
        method: "POST",
        body: JSON.stringify({ hidden: next }),
      }),
    ).then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setSaving(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Section
      title="In the model picker"
      description="Hide models nobody here should use"
    >
      <ErrorText size="caption">{error}</ErrorText>
      <Rows label="Providers in the model picker">
        {[...byProvider].map(([provider, listed]) => {
          const shown = listed.filter(
            (model) => !hidden.includes(modelKey(model)),
          );

          return (
            <Row
              key={provider}
              initials={initialsOf(provider)}
              title={provider}
              description={
                <span className="flex flex-col gap-2">
                  <span>
                    {listed
                      .slice(0, 3)
                      .map(({ id }) => id)
                      .join(", ")}{" "}
                    · {listed.length} {listed.length === 1 ? "model" : "models"}
                  </span>
                  {choosing === provider && (
                    <span
                      role="group"
                      aria-label={`${provider} models`}
                      className="flex flex-col gap-1.5"
                    >
                      {listed.map((model) => {
                        const key = modelKey(model);

                        return (
                          <label
                            key={key}
                            className="flex items-center gap-2 font-mono text-mono-sm text-fg"
                          >
                            <input
                              type="checkbox"
                              checked={!hidden.includes(key)}
                              onChange={(event) => {
                                save(
                                  event.target.checked
                                    ? hidden.filter((each) => each !== key)
                                    : [...hidden, key],
                                );
                              }}
                            />
                            {model.id}
                          </label>
                        );
                      })}
                    </span>
                  )}
                </span>
              }
            >
              <span className="text-label text-fg-dim">
                {shown.length} of {listed.length} shown
              </span>
              <Button
                variant="ghost"
                aria-expanded={choosing === provider}
                aria-label={`Choose ${provider} models`}
                onClick={() => {
                  setChoosing(choosing === provider ? undefined : provider);
                }}
              >
                {choosing === provider ? "Done" : "Choose"}
              </Button>
            </Row>
          );
        })}
      </Rows>
    </Section>
  );
}

function Aliases({
  context,
  environment,
  saved,
  adding,
  onAdding,
  onSaved,
}: {
  readonly context: WebContext;
  readonly environment: Environment;
  readonly saved: EnvironmentModels | undefined;
  readonly adding: boolean;
  readonly onAdding: (adding: boolean) => void;
  readonly onSaved: () => void;
}): ReactElement {
  const health = saved?.health ?? noHealth;
  const config = saved?.aliases ?? { models: {} };
  const [error, setError] = useState<string>();
  const list = `models-${environment.id}`;

  const save = (aliases: AliasConfig | null): void => {
    json(
      context.request(`environments/${encodeURIComponent(environment.id)}`, {
        method: "POST",
        body: JSON.stringify({ aliases }),
      }),
    ).then(
      () => {
        setError(undefined);
        onSaved();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const setModels = (
    next: AliasConfig["models"],
    defaultAlias = config.defaultAlias,
  ): void => {
    if (Object.keys(next).length === 0) {
      save(null);

      return;
    }

    const { defaultAlias: _, ...rest } = config;

    save({
      ...rest,
      models: next,
      ...(defaultAlias !== undefined &&
        defaultAlias in next && { defaultAlias }),
    });
  };

  const providers = [
    ...new Set(
      Object.values(config.models)
        .flat()
        .flatMap((value) => modelRef(value)?.provider ?? []),
    ),
  ];

  return (
    <>
      <datalist id={list}>
        {environment.models
          .filter(({ provider }) => provider !== gatewayProvider)
          .map((model) => (
            <option key={modelKey(model)} value={modelKey(model)} />
          ))}
      </datalist>
      <ErrorText size="caption" className="mt-4">{error}</ErrorText>
      <div className="mt-6 flex flex-col gap-4">
        {adding && (
          <NewAlias
            taken={aliasesOf(config)}
            list={list}
            add={(name, model) => {
              setModels({ ...config.models, [name]: [model] });
              onAdding(false);
            }}
            cancel={() => {
              onAdding(false);
            }}
          />
        )}
        {aliasesOf(config).length === 0 && !adding && (
          <Rows>
            <Row
              title="No aliases yet"
              description={`Sessions in ${environment.name} use the model they pick. Add an alias to give them fallbacks.`}
            />
          </Rows>
        )}
        {aliasesOf(config).map((alias) => (
          <AliasCard
            key={alias}
            name={alias}
            tried={config.models[alias] ?? []}
            isDefault={config.defaultAlias === alias}
            health={health}
            list={list}
            onChange={(next) => {
              setModels({ ...config.models, [alias]: next });
            }}
            onDefault={() => {
              setModels(config.models, alias);
            }}
            onRename={(name) => {
              setModels(
                Object.fromEntries(
                  Object.entries(config.models).map(([key, tried]) => [
                    key === alias ? name : key,
                    tried,
                  ]),
                ),
                config.defaultAlias === alias ? name : config.defaultAlias,
              );
            }}
            onRemove={() => {
              setModels(
                Object.fromEntries(
                  Object.entries(config.models).filter(
                    ([other]) => other !== alias,
                  ),
                ),
              );
            }}
          />
        ))}
      </div>
      {providers.length > 0 && (
        <Section
          title="When a provider runs out"
          description="Its models step aside until it resets"
        >
          {providers.map((provider) => (
            <ProviderEditor
              key={`${provider}-${JSON.stringify(config.providers?.[provider] ?? {})}`}
              name={provider}
              settings={config.providers?.[provider] ?? {}}
              down={health.unhealthyUntil[provider]}
              now={new Date()}
              onChange={(settings) => {
                const others = Object.entries(config.providers ?? {}).filter(
                  ([other]) => other !== provider,
                );

                save({
                  ...config,
                  providers: Object.fromEntries(
                    Object.keys(settings).length === 0
                      ? others
                      : [...others, [provider, settings]],
                  ),
                });
              }}
            />
          ))}
        </Section>
      )}
      {saved?.aliases !== null && saved?.aliases !== undefined && (
        <p className="mt-6 text-caption text-fg-dim">
          Sessions see each alias as {gatewayProvider}/name.{" "}
          <button
            type="button"
            className="cursor-pointer text-fg underline underline-offset-2"
            onClick={() => {
              save(null);
            }}
          >
            Turn aliases off
          </button>
        </p>
      )}
    </>
  );
}

function NewAlias({
  taken,
  list,
  add,
  cancel,
}: {
  readonly taken: readonly string[];
  readonly list: string;
  readonly add: (name: string, model: string) => void;
  readonly cancel: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const clash = taken.includes(name);
  const ready = name !== "" && !clash && modelRef(model) !== undefined;

  return (
    <form
      aria-label="New alias"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-elevated p-4 shadow-xs"
      onSubmit={(event) => {
        event.preventDefault();

        if (ready) {
          add(name, model);
        }
      }}
    >
      <input
        aria-label="New alias name"
        placeholder="smart"
        value={name}
        autoFocus
        onChange={(event) => {
          setName(event.target.value.trim());
        }}
        className={cn(fieldClass, "w-40 font-mono text-mono-sm")}
      />
      <input
        list={list}
        aria-label="First model"
        placeholder="provider/model to try first"
        value={model}
        onChange={(event) => {
          setModel(event.target.value.trim());
        }}
        className={cn(fieldClass, "flex-1 font-mono text-mono-sm")}
      />
      <Button variant="primary" type="submit" disabled={!ready}>
        Add alias
      </Button>
      <Button variant="ghost" onClick={cancel}>
        Cancel
      </Button>
      {clash && (
        <ErrorText size="caption" className="w-full">
          {name} is already an alias.
        </ErrorText>
      )}
    </form>
  );
}

function AliasCard({
  name,
  tried,
  isDefault,
  health,
  list,
  onChange,
  onDefault,
  onRename,
  onRemove,
}: {
  readonly name: string;
  readonly tried: readonly string[];
  readonly isDefault: boolean;
  readonly health: Health;
  readonly list: string;
  readonly onChange: (models: readonly string[]) => void;
  readonly onDefault: () => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState("");
  const now = new Date();

  const move = (from: number, to: number): void => {
    const next = [...tried];
    const [moved] = next.splice(from, 1);

    if (moved !== undefined) {
      next.splice(to, 0, moved);
      onChange(next);
    }
  };

  return (
    <section
      aria-label={`Alias ${name}`}
      className="flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 shadow-xs"
    >
      <header className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <form
            aria-label={`Rename ${name}`}
            className="flex flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const field = new FormData(event.currentTarget).get("name");
              const next = typeof field === "string" ? field.trim() : "";

              if (next !== "" && next !== name) {
                onRename(next);
              }

              setRenaming(false);
            }}
          >
            <input
              name="name"
              aria-label="Alias name"
              defaultValue={name}
              autoFocus
              className={cn(fieldClass, "flex-1 font-mono text-mono-sm")}
            />
            <Button type="submit">Save</Button>
          </form>
        ) : (
          <>
            <h2 className="text-prose font-semibold text-fg-strong">{name}</h2>
            {isDefault ? (
              <Badge state="offline">Default for new Sessions</Badge>
            ) : (
              <Button variant="ghost" onClick={onDefault}>
                Make default
              </Button>
            )}
            <span className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                onClick={() => {
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                aria-label={`Remove ${name}`}
                onClick={onRemove}
              >
                Remove
              </Button>
            </span>
          </>
        )}
      </header>
      <ol aria-label={`${name} models`} className="flex flex-col gap-2">
        {tried.map((value, index) => {
          const ref = modelRef(value);
          const down = ref && unhealthy(health, ref, now);

          return (
            <li
              key={value}
              aria-label={value}
              className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5"
            >
              <span
                aria-hidden="true"
                className="grid size-6 place-items-center rounded-full border border-line-strong text-caption text-fg"
              >
                {index + 1}
              </span>
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-md bg-hover text-caption font-semibold text-fg-strong"
              >
                {initialsOf(ref?.provider ?? value)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-fg-strong">
                  {ref?.id ?? value}
                </span>
                <span className="text-label text-fg-dim">
                  {ref?.provider ?? "not a provider/model"}
                </span>
              </span>
              {ref && (
                <Select
                  aria-label={`Reasoning of ${value}`}
                  value={ref.thinking ?? ""}
                  onChange={(event) => {
                    const level = thinkingLevels.find(
                      (each) => each === event.target.value,
                    );

                    const next = modelValue({
                      provider: ref.provider,
                      id: ref.id,
                      ...(level && { thinking: level }),
                    });

                    onChange(
                      tried.map((other, at) => (at === index ? next : other)),
                    );
                  }}
                >
                  <option value="">Session&apos;s reasoning</option>
                  {thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {reasoningLabel(level)}
                    </option>
                  ))}
                </Select>
              )}
              {down === undefined ? (
                <Badge state="done">Ready</Badge>
              ) : (
                <Badge state="waiting">
                  Cooling down, {minutesLeft(down.until, now)} min
                </Badge>
              )}
              <span className="flex">
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={`Move ${value} up`}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, index - 1);
                  }}
                >
                  <Icon name="arrow-up" />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={`Remove ${value} from ${name}`}
                  disabled={tried.length === 1}
                  onClick={() => {
                    onChange(tried.filter((other) => other !== value));
                  }}
                >
                  <Icon name="x" />
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      <form
        aria-label={`Add a fallback to ${name}`}
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();

          if (modelRef(adding) !== undefined && !tried.includes(adding)) {
            onChange([...tried, adding]);
            setAdding("");
          }
        }}
      >
        <Icon name="plus" />
        <input
          list={list}
          value={adding}
          aria-label={tried.length === 0 ? "Add a model" : "Add a fallback"}
          placeholder={
            tried.length === 0
              ? "Add a model, as provider/model"
              : "Add a fallback"
          }
          onChange={(event) => {
            setAdding(event.target.value.trim());
          }}
          className="h-8 flex-1 bg-transparent font-mono text-mono-sm outline-none"
        />
        {adding !== "" && <Button type="submit">Add</Button>}
      </form>
    </section>
  );
}

function reasoningLabel(level: string): string {
  if (level === "off") {
    return "No reasoning";
  }

  const name = level === "xhigh" ? "Extra high" : level;

  return `${name.charAt(0).toUpperCase()}${name.slice(1)} reasoning`;
}

function minutesLeft(until: string, now: Date): number {
  return Math.max(1, Math.ceil((Date.parse(until) - now.getTime()) / 60_000));
}

function ProviderEditor({
  name,
  settings,
  down,
  now,
  onChange,
}: {
  readonly name: string;
  readonly settings: ProviderSettings;
  readonly down: Health["unhealthyUntil"][string] | undefined;
  readonly now: Date;
  readonly onChange: (settings: ProviderSettings) => void;
}): ReactElement {
  const capped = down !== undefined && Date.parse(down.until) > now.getTime();

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line bg-bg p-4">
      <legend className="flex items-center gap-2 px-1 font-mono text-mono">
        {name}
        {capped ? (
          <Badge state="failed">
            Capped until {new Date(down.until).toLocaleString()} ({down.reason})
          </Badge>
        ) : (
          <Badge state="done">Healthy</Badge>
        )}
      </legend>
      <div className="flex flex-wrap items-center gap-4 text-label text-fg-dim">
        <label className="flex items-center gap-2">
          Cap status codes
          <input
            placeholder="402"
            defaultValue={(settings.capStatusCodes ?? []).join(", ")}
            onBlur={(event) => {
              const parsed = event.target.value
                .split(",")
                .map((code) => Number(code.trim()))
                .filter((code) => Number.isInteger(code) && code > 0);

              const { capStatusCodes: _, ...rest } = settings;

              onChange(
                parsed.length === 0
                  ? rest
                  : { ...rest, capStatusCodes: parsed },
              );
            }}
            className={cn(fieldClass, "w-28")}
          />
        </label>
        <label className="flex items-center gap-2">
          Reset
          <Select
            value={settings.resetSchedule ?? ""}
            onChange={(event) => {
              const { resetSchedule: _, ...rest } = settings;

              onChange(
                event.target.value === ""
                  ? rest
                  : { ...rest, resetSchedule: event.target.value },
              );
            }}
          >
            {schedules.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "1 hour after a cap" : value}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </fieldset>
  );
}
