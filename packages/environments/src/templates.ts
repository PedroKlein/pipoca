import {
  BadRequest,
  checkBody,
  Config,
  HttpError,
  isObject,
  kernelConfig,
  NotFound,
  type ConfigKey,
  type Static,
} from "@pipoca/plugins";
import {
  listedIn,
  picked,
  repositoryFile,
  syncFollowers,
  withClone,
} from "@pipoca/repositories";
import {
  type EnvironmentTemplate,
  environmentUpdate,
  type Log,
  type ManifestEntry,
  type RepositorySource,
  templateEntry,
} from "@pipoca/protocol";

export interface Templates {
  readonly list: () => readonly EnvironmentTemplate[];
  readonly create: (body: unknown) => EnvironmentTemplate;
  readonly update: (id: string, body: unknown) => EnvironmentTemplate;
  readonly remove: (id: string) => void;
  // What a repository's pipoca.json lists, and the picked ones as templates
  // that follow it (ADR 0063).
  readonly listed: (url: string) => Promise<readonly ManifestEntry[]>;
  readonly importListed: (
    url: string,
    paths: readonly string[],
  ) => Promise<readonly EnvironmentTemplate[]>;
  readonly sync: (url?: string) => Promise<void>;
  // A plugin's key in a template's entry, such as its pod settings.
  readonly config: (id: string, plugin: string) => unknown;
  readonly setConfig: (id: string, plugin: string, value: unknown) => void;
}

const templateFields = new Set([
  "id",
  "name",
  "isolation",
  "image",
  "setupScript",
  "variables",
  "aliases",
  "source",
]);

// Admins keep Environment templates under "templates" in pipoca.json, so a
// Helm value can set them as well as Settings (ADR 0039, ADR 0049). An entry
// also holds a key per plugin, which saves keep.
export function environmentTemplates(config: ConfigKey, log: Log): Templates {
  const read = kernelConfig(
    config,
    Config.collection({ title: "Templates", key: "id", item: templateEntry }),
    log,
  );

  const list = (): readonly EnvironmentTemplate[] => read().map(templateOf);

  const entries = (): readonly Readonly<Record<string, unknown>>[] => {
    const value = config.get();

    return Array.isArray(value) ? value.filter(isObject) : [];
  };

  const entryOf = (id: string): Readonly<Record<string, unknown>> | undefined =>
    entries().find((entry) => entry["id"] === id);

  const pluginKeys = (id: string): Readonly<Record<string, unknown>> =>
    Object.fromEntries(
      Object.entries(entryOf(id) ?? {}).filter(
        ([key]) => !templateFields.has(key),
      ),
    );

  const save = (templates: readonly EnvironmentTemplate[]): void => {
    config.set(
      templates.map((template) => ({
        ...pluginKeys(template.id),
        ...template,
      })),
    );
  };

  const freeId = (name: string, taken: ReadonlySet<string>): string => {
    const base = slug(name);

    let id = base;
    for (let n = 2; taken.has(id); n++) {
      id = `${base}-${String(n)}`;
    }

    return id;
  };

  const sync = async (url?: string): Promise<void> => {
    const updated = new Map<string, EnvironmentTemplate>();

    await syncFollowers(list(), {
      kind: "template",
      url,
      log,
      update: (template, { dir }, source) => {
        updated.set(template.id, {
          ...fromFile(dir, template.name, source),
          id: template.id,
        });
      },
      updated: () => {
        if (updated.size > 0) {
          save(list().map((template) => updated.get(template.id) ?? template));
          updated.clear();
        }
      },
    });
  };

  return {
    list,
    create: (body) => {
      const fields = settingsOf(body);
      if (fields.name === undefined) {
        throw new BadRequest("name is required");
      }

      const created: EnvironmentTemplate = {
        id: freeId(fields.name, new Set(list().map(({ id }) => id))),
        name: fields.name,
        isolation: fields.isolation ?? "process",
        image: fields.image ?? null,
        setupScript: fields.setupScript ?? "",
        variables: fields.variables ?? {},
        aliases: null,
        source: null,
      };

      save([...list(), created]);

      return created;
    },
    update: (id, body) => {
      const templates = list();
      const template = templates.find((each) => each.id === id);
      if (template === undefined) {
        throw new NotFound(`no template ${id}`);
      }

      if (template.source !== null) {
        throw new HttpError(
          409,
          "This template follows its repository. Change it there.",
          "synced",
        );
      }

      const updated = { ...template, ...settingsOf(body) };
      save(templates.map((each) => (each.id === id ? updated : each)));

      return updated;
    },
    remove: (id) => {
      const templates = list();
      if (!templates.some((each) => each.id === id)) {
        throw new NotFound(`no template ${id}`);
      }

      save(templates.filter((each) => each.id !== id));
    },
    listed: async (url) =>
      withClone(url, ({ dir }) => listedIn(dir, "templates")),
    importListed: async (url, paths) =>
      withClone(url, ({ dir, commit }) => {
        const taken = new Set(list().map(({ id }) => id));

        const imported = picked(listedIn(dir, "templates"), paths).map(
          ({ name, path }) => {
            const template = {
              ...fromFile(dir, name, { url, path, commit }),
              id: freeId(name, taken),
            };

            taken.add(template.id);

            return template;
          },
        );

        save([...list(), ...imported]);

        return imported;
      }),
    sync,
    config: (id, plugin) => {
      const entry = entryOf(id);

      return entry !== undefined && Object.hasOwn(entry, plugin)
        ? entry[plugin]
        : undefined;
    },
    setConfig: (id, plugin, value) => {
      if (templateFields.has(plugin)) {
        throw new Error(`${plugin} is a template's own field`);
      }

      if (!list().some((each) => each.id === id)) {
        throw new NotFound(`no template ${id}`);
      }

      config.set(
        entries().map((entry) => {
          if (entry["id"] !== id) {
            return entry;
          }

          const { [plugin]: _, ...rest } = entry;

          return value === undefined ? rest : { ...rest, [plugin]: value };
        }),
      );
    },
  };
}

// A template file holds what Settings shows for a template, without its name.
function fromFile(
  dir: string,
  name: string,
  source: RepositorySource,
): Omit<EnvironmentTemplate, "id"> {
  let value: unknown;
  try {
    value = JSON.parse(repositoryFile(dir, source.path));
  } catch (error) {
    throw error instanceof SyntaxError
      ? new BadRequest(`${source.path} is not JSON`)
      : error;
  }

  const { aliases, ...settings } = (value ?? {}) as Record<string, unknown>;
  const fields = settingsOf({ ...settings, name });

  return {
    name,
    isolation: fields.isolation ?? "process",
    image: fields.image ?? null,
    setupScript: fields.setupScript ?? "",
    variables: fields.variables ?? {},
    aliases: aliasesOf(aliases),
    source,
  };
}

// A template holds no secrets: they belong to each person's Environment.
function settingsOf(body: unknown): Partial<Omit<EnvironmentTemplate, "id">> {
  const { secrets, name, ...settings } = checkBody(body, environmentUpdate);
  if (secrets !== undefined) {
    throw new BadRequest("a template holds no secrets");
  }

  return { ...settings, ...(name !== undefined && { name: name.trim() }) };
}

function templateOf(entry: Static<typeof templateEntry>): EnvironmentTemplate {
  return {
    id: entry.id,
    name: entry.name?.trim() ?? entry.id,
    isolation: entry.isolation ?? "process",
    image: entry.image ?? null,
    setupScript: entry.setupScript ?? "",
    variables: entry.variables ?? {},
    aliases: entry.aliases ?? null,
    source: entry.source ?? null,
  };
}

// The models plugin checks the aliases themselves.
function aliasesOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest("aliases must be an object");
  }

  return value as Readonly<Record<string, unknown>>;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "template"
  );
}
