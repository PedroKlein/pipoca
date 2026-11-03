import {
  BadRequest,
  HttpError,
  NotFound,
  type PluginConfig,
} from "@pipoca/plugins";
import { listedIn, repositoryFile, withClone } from "@pipoca/profiles";
import type {
  EnvironmentTemplate,
  ManifestEntry,
  RepositorySource,
} from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import { environmentUpdate } from "./requests";

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
}

// Admins keep Environment templates under "templates" in pipoca.json, so a
// Helm value can set them as well as Settings (ADR 0039, ADR 0049). An entry
// that doesn't read is left out and logged, and the others still work.
export function environmentTemplates(
  config: PluginConfig,
  log: Log,
): Templates {
  const list = (): readonly EnvironmentTemplate[] => {
    const value = config.get();
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      log("templates unreadable", { error: "templates must be a list" });

      return [];
    }

    return value.flatMap((entry: unknown) => {
      try {
        return [templateOf(entry)];
      } catch (error) {
        log("template unreadable", { error: String(error) });

        return [];
      }
    });
  };

  const save = (templates: readonly EnvironmentTemplate[]): void => {
    config.set(templates);
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
    const synced = list().filter(
      ({ source }) =>
        source !== null && (url === undefined || source.url === url),
    );

    if (synced.length === 0) {
      return;
    }

    const urls = [...new Set(synced.map(({ source }) => source?.url ?? ""))];
    let changed = 0;
    let failed = 0;

    log("templates syncing", {
      templates: synced.length,
      repositories: urls.length,
    });

    for (const each of urls) {
      await withClone(each, ({ dir, commit }) => {
        const updated = new Map<string, EnvironmentTemplate>();

        for (const template of synced) {
          const { source } = template;
          if (source?.url !== each || source.commit === commit) {
            continue;
          }

          try {
            updated.set(template.id, {
              ...fromFile(dir, template.name, { ...source, commit }),
              id: template.id,
            });

            changed++;
            log("template synced", { templateId: template.id, commit });
          } catch (error) {
            failed++;

            log("template sync failed", {
              templateId: template.id,
              error: String(error),
            });
          }
        }

        if (updated.size > 0) {
          save(list().map((template) => updated.get(template.id) ?? template));
        }
      }).catch((error: unknown) => {
        failed++;
        log("template sync failed", { url: each, error: String(error) });
      });
    }

    log("templates synced", { checked: synced.length, changed, failed });
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
    listed: async (url) =>
      withClone(url, ({ dir }) => listedIn(dir, "templates")),
    importListed: async (url, paths) =>
      withClone(url, ({ dir, commit }) => {
        const listed = listedIn(dir, "templates");
        const taken = new Set(list().map(({ id }) => id));

        const imported = paths.map((path) => {
          const found = listed.find((each) => each.path === path);
          if (!found) {
            throw new BadRequest(`pipoca.json doesn't list ${path}`);
          }

          const template = {
            ...fromFile(dir, found.name, { url, path, commit }),
            id: freeId(found.name, taken),
          };

          taken.add(template.id);

          return template;
        });

        save([...list(), ...imported]);

        return imported;
      }),
    sync,
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

  const fields = settingsOf({ ...(value as object), name });

  return {
    name,
    isolation: fields.isolation ?? "process",
    image: fields.image ?? null,
    setupScript: fields.setupScript ?? "",
    variables: fields.variables ?? {},
    source,
  };
}

// A template holds no secrets: they belong to each person's Environment.
function settingsOf(body: unknown): Partial<Omit<EnvironmentTemplate, "id">> {
  const { secrets, ...settings } = environmentUpdate(body);
  if (secrets !== undefined) {
    throw new BadRequest("a template holds no secrets");
  }

  return settings;
}

function templateOf(entry: unknown): EnvironmentTemplate {
  const { id, source } = (entry ?? {}) as { id?: unknown; source?: unknown };
  if (typeof id !== "string" || id === "") {
    throw new Error("a template needs an id");
  }

  const fields = settingsOf(entry);

  return {
    id,
    name: fields.name ?? id,
    isolation: fields.isolation ?? "process",
    image: fields.image ?? null,
    setupScript: fields.setupScript ?? "",
    variables: fields.variables ?? {},
    source: sourceOf(source),
  };
}

function sourceOf(value: unknown): RepositorySource | null {
  const { url, path, commit } = (value ?? {}) as Record<string, unknown>;

  return typeof url === "string" &&
    typeof path === "string" &&
    typeof commit === "string"
    ? { url, path, commit }
    : null;
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
