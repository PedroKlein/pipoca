import {
  BadRequest,
  Config,
  HttpError,
  NotFound,
  type Static,
} from "@pipoca/plugins";
import {
  checkBody,
  type ConfigKey,
  isObject,
  kernelConfig,
} from "@pipoca/plugins/host";
import {
  type CloneOptions,
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
  readonly listed: (
    url: string,
    clone?: CloneOptions,
  ) => Promise<readonly ManifestEntry[]>;
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
  "source",
]);

// Admins keep Environment templates under "templates" in pipoca.json, so a
// Helm value can set them as well as Settings (ADR 0039, ADR 0049). An entry
// also holds a key per plugin, which saves keep. A template file never sets a
// key only admins set, so the entry's own stays (ADR 0049).
export function environmentTemplates(
  config: ConfigKey,
  log: Log,
  adminKeys: readonly string[] = [],
): Templates {
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

  const fileOf = (
    dir: string,
    name: string,
    source: RepositorySource,
  ): ReturnType<typeof fromFile> => {
    const file = fromFile(dir, name, source);
    const left = adminKeys.filter((key) => Object.hasOwn(file.plugins, key));

    if (left.length > 0) {
      log("template file keys only admins set left out", {
        path: source.path,
        keys: left,
      });
    }

    return {
      ...file,
      plugins: Object.fromEntries(
        Object.entries(file.plugins).filter(([key]) => !left.includes(key)),
      ),
    };
  };

  // A template file's plugin keys replace the entry's.
  const save = (
    templates: readonly EnvironmentTemplate[],
    fromFiles: ReadonlyMap<string, PluginKeys> = new Map(),
  ): void => {
    config.set(
      templates.map((template) => ({
        ...pluginKeys(template.id),
        ...fromFiles.get(template.id),
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
    const fromFiles = new Map<string, PluginKeys>();

    await syncFollowers(list(), {
      kind: "template",
      url,
      log,
      update: (template, { dir }, source) => {
        const { plugins, ...settings } = fileOf(dir, template.name, source);

        updated.set(template.id, { ...settings, id: template.id });
        fromFiles.set(template.id, plugins);
      },
      updated: () => {
        if (updated.size > 0) {
          save(
            list().map((template) => updated.get(template.id) ?? template),
            fromFiles,
          );

          updated.clear();
          fromFiles.clear();
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
    listed: async (url, clone) =>
      withClone(url, ({ dir }) => listedIn(dir, "templates"), clone),
    importListed: async (url, paths) =>
      withClone(url, ({ dir, commit }) => {
        const taken = new Set(list().map(({ id }) => id));
        const fromFiles = new Map<string, PluginKeys>();

        const imported = picked(listedIn(dir, "templates"), paths).map(
          ({ name, path }) => {
            const { plugins, ...settings } = fileOf(dir, name, {
              url,
              path,
              commit,
            });

            const template = { ...settings, id: freeId(name, taken) };

            taken.add(template.id);
            fromFiles.set(template.id, plugins);

            return template;
          },
        );

        save([...list(), ...imported], fromFiles);

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

type PluginKeys = Readonly<Record<string, unknown>>;

// A template file holds what Settings shows for a template, without its
// name, and a key per plugin.
function fromFile(
  dir: string,
  name: string,
  source: RepositorySource,
): Omit<EnvironmentTemplate, "id"> & { readonly plugins: PluginKeys } {
  let value: unknown;
  try {
    value = JSON.parse(repositoryFile(dir, source.path));
  } catch (error) {
    throw error instanceof SyntaxError
      ? new BadRequest(`${source.path} is not JSON`)
      : error;
  }

  const entries = Object.entries(isObject(value) ? value : {});

  const own = (key: string): boolean =>
    Object.hasOwn(environmentUpdate.properties, key);

  const fields = settingsOf({
    ...Object.fromEntries(entries.filter(([key]) => own(key))),
    name,
  });

  return {
    name,
    isolation: fields.isolation ?? "process",
    image: fields.image ?? null,
    setupScript: fields.setupScript ?? "",
    variables: fields.variables ?? {},
    source,
    plugins: Object.fromEntries(
      entries.filter(([key]) => !own(key) && !templateFields.has(key)),
    ),
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
    source: entry.source ?? null,
  };
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
