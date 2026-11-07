import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ManifestEntry,
  type PiPackage,
  type Profile,
  type ProfileContent,
  type RepositorySource,
  emptyProfile,
  profilePath,
  type Log,
} from "@pipoca/protocol";
import {
  defaultProfileId,
  isRecord,
  maxBuildsOn,
  type ProfileFolders,
  type ProfileLayer,
  type StoredProfile,
} from "./folders";
import { InvalidProfile } from "./invalid";
import {
  type CloneOptions,
  listedIn,
  picked,
  repositoryFolder,
  syncFollowers,
  withClone,
} from "@pipoca/repositories";
import { readFileSync } from "node:fs";
import { folderEntries } from "./files";

export interface ProfileStore {
  readonly defaultProfileId: (ownerId: string) => string;
  readonly setDefaultProfile: (ownerId: string, id: string) => void;
  // Unarchived Sessions that run with the Profile.
  readonly profileInUse: (id: string) => boolean;
  // Who last changed the base Profile, whose git logins install its
  // packages on the server (ADR 0044).
  readonly baseEdited: (userId: string) => void;
  readonly baseEditor: () => string | undefined;
}

export type Layer = "base" | "defaults";

type Rejection =
  "not_found" | "default" | "in_use" | "admin_only" | "synced" | "team";

interface ProfileEntry {
  readonly path: string;
  readonly size: number;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

// The file a repository shares a Profile in, at its root.
const exportFile = "pipoca-profile.json";
const maxExportBytes = 1024 * 1024;

// Each user sees their own Profiles and the shared ones, which only admins
// change, and picks their own default (ADR 0041).
export class Profiles {
  readonly #folders: ProfileFolders;
  readonly #store: ProfileStore;

  constructor(folders: ProfileFolders, store: ProfileStore) {
    this.#folders = folders;
    this.#store = store;
  }

  // Every user's Profiles, which runners keep.
  ids(): readonly string[] {
    return this.#folders.ids();
  }

  // A person's own and shared Profiles, or the team's, which only team work
  // runs on (ADR 0064).
  list(userId: string, { team = false } = {}): readonly Profile[] {
    return this.#folders
      .ids()
      .flatMap((id) => {
        const profile = this.#visible(userId, id);

        return profile && (profile.ownerId === teamOwner) === team
          ? [this.#view(userId, profile)]
          : [];
      })
      .sort(
        (a, b) =>
          Number(b.id === defaultProfileId) -
            Number(a.id === defaultProfileId) || a.name.localeCompare(b.name),
      );
  }

  get(userId: string, id: string): Profile | undefined {
    const profile = this.#visible(userId, id);

    return profile && this.#view(userId, profile);
  }

  // Throws InvalidProfile when the body isn't a name with Profile content.
  create(userId: string, body: unknown, admin: boolean): Result<Profile> {
    const fields = fieldsOf(body);
    const name = nameOf(fields["name"]);
    const content = contentOf(fields);

    const team = fields["team"] === true;

    if ((fields["shared"] === true || team) && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    const id = this.#folders.freeId(name);
    const ownerId = ownerOf(userId, team, fields["shared"] === true);

    const profile: StoredProfile = {
      id,
      name,
      ownerId,
      buildsOn: this.#buildsOn(id, ownerId, fields["buildsOn"]),
      source: null,
      createdAt: new Date().toISOString(),
      ...content,
    };

    this.#folders.write(profile.id, profile, content);

    return { ok: true, value: this.#view(userId, profile) };
  }

  // Edits reach a Session the next time its Pi process starts (ADR 0031).
  update(
    userId: string,
    id: string,
    body: unknown,
    admin: boolean,
  ): Result<Profile> {
    const profile = this.#visible(userId, id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (profile.source) {
      return { ok: false, reason: "synced" };
    }

    if (!mine(profile, userId) && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    const fields = fieldsOf(body);
    const content = contentOf({ ...profile, ...fields });

    const updated: StoredProfile = {
      ...profile,
      ...(fields["name"] !== undefined && { name: nameOf(fields["name"]) }),
      ...("buildsOn" in fields && {
        buildsOn: this.#buildsOn(id, profile.ownerId, fields["buildsOn"]),
      }),
      ...content,
    };

    const given = Object.fromEntries(
      Object.entries(content).filter(([key]) => key in fields),
    );

    this.#folders.write(id, updated, given);

    return { ok: true, value: this.#view(userId, updated) };
  }

  remove(userId: string, id: string, admin: boolean): Result<undefined> {
    const profile = this.#visible(userId, id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (!mine(profile, userId) && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    if (
      id === defaultProfileId ||
      this.#store.defaultProfileId(userId) === id
    ) {
      return { ok: false, reason: "default" };
    }

    if (this.#store.profileInUse(id)) {
      return { ok: false, reason: "in_use" };
    }

    this.#folders.remove(id);

    return { ok: true, value: undefined };
  }

  makeDefault(userId: string, id: string): Result<Profile> {
    const profile = this.#visible(userId, id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (profile.ownerId === teamOwner) {
      return { ok: false, reason: "team" };
    }

    this.#store.setDefaultProfile(userId, id);

    return { ok: true, value: this.#view(userId, profile) };
  }

  // A Profile's own files, without the admin's base Profile, as a .tar.gz
  // runners would unpack to the same folder (ADR 0041).
  async archive(userId: string, id: string): Promise<Uint8Array | undefined> {
    const files = this.#visible(userId, id) && this.#folders.ownFiles(id);
    if (!files) {
      return undefined;
    }

    const decoded = Object.fromEntries(
      Object.entries(files.files).map(([path, content]) => [
        path,
        Buffer.from(content, "base64"),
      ]),
    );

    return new Bun.Archive(decoded, { compress: "gzip" }).bytes();
  }

  files(userId: string, id: string): readonly ProfileEntry[] | undefined {
    return this.#visible(userId, id) && this.#folders.entries(id);
  }

  file(userId: string, id: string, path: string): Buffer | undefined {
    return this.#visible(userId, id) && this.#folders.file(id, path);
  }

  // Throws InvalidProfile for a path a Profile can't hold, and ProfileTooBig.
  writeFiles(
    userId: string,
    id: string,
    files: ReadonlyMap<string, Buffer>,
    admin: boolean,
  ): Result<undefined> {
    const denied = this.#denied(userId, id, admin);
    if (denied) {
      return denied;
    }

    this.#folders.writeFiles(id, files);

    return { ok: true, value: undefined };
  }

  deleteFile(
    userId: string,
    id: string,
    path: string,
    admin: boolean,
  ): Result<undefined> {
    const denied = this.#denied(userId, id, admin);
    if (denied) {
      return denied;
    }

    return this.#folders.deleteFile(id, path)
      ? { ok: true, value: undefined }
      : { ok: false, reason: "not_found" };
  }

  // A layer under every Profile: the admin's base (ADR 0044), or the
  // person's own My defaults (ADR 0063).
  layer(userId: string, which: Layer): ProfileContent {
    return this.#layer(userId, which)?.read() ?? emptyProfile;
  }

  // The MCP servers a person's Sessions may connect to, as the mcp.json
  // files of the base, their My defaults and the Profiles they see
  // configure them.
  mcpServers(
    userId: string,
  ): readonly { readonly name: string; readonly config: unknown }[] {
    const profiles = this.ids().flatMap(
      (id) => this.#visible(userId, id) ?? [],
    );

    const layers = [this.#folders.base, this.#folders.defaults(userId)]
      .filter((layer) => layer !== undefined)
      .map((layer) => layer.read());

    return [...layers, ...profiles].flatMap(({ mcpServers }) =>
      Object.entries(mcpServers).map(([name, config]) => ({ name, config })),
    );
  }

  // Throws InvalidProfile when the body isn't Profile content.
  updateLayer(
    userId: string,
    which: Layer,
    body: unknown,
    admin: boolean,
  ): Result<ProfileContent> {
    const layer = this.#writable(userId, which, admin);
    if (!layer.ok) {
      return layer;
    }

    const fields = fieldsOf(body);
    const content = contentOf({ ...layer.value.read(), ...fields });

    layer.value.write(
      Object.fromEntries(
        Object.entries(content).filter(([key]) => key in fields),
      ),
    );

    return { ok: true, value: content };
  }

  layerFiles(userId: string, which: Layer): readonly ProfileEntry[] {
    return this.#layer(userId, which)?.entries() ?? [];
  }

  layerFile(userId: string, which: Layer, path: string): Buffer | undefined {
    return this.#layer(userId, which)?.file(path);
  }

  // Throws InvalidProfile for a path a Profile can't hold, and ProfileTooBig.
  writeLayerFiles(
    userId: string,
    which: Layer,
    files: ReadonlyMap<string, Buffer>,
    admin: boolean,
  ): Result<undefined> {
    const layer = this.#writable(userId, which, admin);
    if (!layer.ok) {
      return layer;
    }

    layer.value.writeFiles(files);

    return { ok: true, value: undefined };
  }

  deleteLayerFile(
    userId: string,
    which: Layer,
    path: string,
    admin: boolean,
  ): Result<undefined> {
    const layer = this.#writable(userId, which, admin);
    if (!layer.ok) {
      return layer;
    }

    return layer.value.deleteFile(path)
      ? { ok: true, value: undefined }
      : { ok: false, reason: "not_found" };
  }

  // A .tar.gz of a Pi agent folder, such as an exported Profile or someone's
  // own ~/.pi/agent. What machines keep for themselves, such as auth.json,
  // is left out.
  async importArchive(
    userId: string,
    name: string,
    archive: Uint8Array,
  ): Promise<Profile> {
    const entries = await new Bun.Archive(archive).files().catch(() => {
      throw new InvalidProfile("that file isn't a .tar.gz");
    });

    const files = new Map<string, Buffer>();
    for (const [path, file] of entries) {
      const relative = path.replace(/^(\.\/)+/, "");
      if (profilePath(relative)) {
        files.set(relative, Buffer.from(await file.arrayBuffer()));
      }
    }

    return this.#createWith(userId, name, files);
  }

  // An import is a copy the importer owns (ADR 0031).
  import(userId: string, file: unknown): Profile {
    const fields = fieldsOf(file);
    if (fields["pipocaProfile"] !== 1) {
      throw new InvalidProfile("not a Pipoca Profile file");
    }

    const { shared: _ignored, ...owned } = fields;
    const created = this.create(userId, owned, false);
    if (!created.ok) {
      throw new InvalidProfile(created.reason);
    }

    return created.value;
  }

  // A repository with a Profile folder at its root, or an older one with a
  // pipoca-profile.json, becomes a Profile the importer owns.
  async importFromGit(
    userId: string,
    url: string,
    clone: CloneOptions = {},
  ): Promise<Profile> {
    return withClone(
      url,
      async ({ dir }) => {
        const file = join(dir, exportFile);
        const info = await lstat(file).catch(() => undefined);
        if (info?.isFile() === true && info.size <= maxExportBytes) {
          return this.import(userId, parsedJson(await readFile(file, "utf8")));
        }

        return this.#createWith(
          userId,
          basename(url).replace(/\.git$/, ""),
          folderFiles(dir, "."),
        );
      },
      clone,
    );
  }

  // The Profiles a repository's pipoca.json lists (ADR 0063).
  async listed(
    url: string,
    clone: CloneOptions = {},
  ): Promise<readonly ManifestEntry[]> {
    return withClone(url, ({ dir }) => listedIn(dir, "profiles"), clone);
  }

  // Each picked folder becomes a Profile of the importer's that follows the
  // repository and can't be edited.
  async importListed(
    userId: string,
    url: string,
    paths: readonly string[],
    clone: CloneOptions = {},
  ): Promise<readonly Profile[]> {
    return withClone(
      url,
      ({ dir, commit }) =>
        picked(listedIn(dir, "profiles"), paths).map(({ name, path }) =>
          this.#createWith(userId, name, folderFiles(dir, path), {
            url,
            path,
            commit,
          }),
        ),
      clone,
    );
  }

  // Brings every synced Profile, or those from one repository, up to the
  // repository's latest commit.
  async sync(log: Log, url?: string): Promise<void> {
    await syncFollowers(
      this.#folders.ids().flatMap((id) => this.#folders.read(id) ?? []),
      {
        kind: "profile",
        url,
        log,
        update: (profile, { dir }, source) => {
          this.#folders.replaceFiles(profile.id, folderFiles(dir, source.path));
          this.#folders.write(profile.id, { ...profile, source }, {});
        },
      },
    );
  }

  async syncOne(
    log: Log,
    userId: string,
    id: string,
  ): Promise<Result<Profile>> {
    const profile = this.#visible(userId, id);
    if (!profile?.source) {
      return { ok: false, reason: "not_found" };
    }

    await this.sync(log, profile.source.url);

    return {
      ok: true,
      value: this.#view(userId, this.#folders.read(id) ?? profile),
    };
  }

  // A Profile of the person's own with the same files, which they can edit.
  copy(userId: string, id: string): Result<Profile> {
    const profile = this.#visible(userId, id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    const files = new Map(
      this.#folders.entries(id).flatMap(({ path }) => {
        const content = this.#folders.file(id, path);

        return content ? [[path, content] as const] : [];
      }),
    );

    return {
      ok: true,
      value: this.#createWith(userId, `${profile.name} copy`, files),
    };
  }

  #createWith(
    userId: string,
    name: string,
    files: ReadonlyMap<string, Buffer>,
    source?: RepositorySource,
  ): Profile {
    const created = this.create(userId, { name }, false);
    if (!created.ok) {
      throw new InvalidProfile(created.reason);
    }

    try {
      this.#folders.writeFiles(created.value.id, files);

      if (source) {
        this.#folders.write(created.value.id, { ...created.value, source }, {});
      }
    } catch (error) {
      this.#folders.remove(created.value.id);
      throw error;
    }

    return this.#view(
      userId,
      this.#folders.read(created.value.id) ?? created.value,
    );
  }

  #denied(
    userId: string,
    id: string,
    admin: boolean,
  ): { readonly ok: false; readonly reason: Rejection } | undefined {
    const profile = this.#visible(userId, id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (profile.source) {
      return { ok: false, reason: "synced" };
    }

    return !mine(profile, userId) && !admin
      ? { ok: false, reason: "admin_only" }
      : undefined;
  }

  // A Profile builds on one its owner can see, a shared Profile only on a
  // shared one and a team Profile only on a team one, so nobody gets someone
  // else's files. Throws InvalidProfile.
  #buildsOn(id: string, ownerId: string | null, value: unknown): string | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const under =
      typeof value === "string" ? this.#folders.read(value) : undefined;

    if (
      under === undefined ||
      (under.ownerId !== ownerId &&
        (under.ownerId !== null || ownerId === teamOwner))
    ) {
      throw new InvalidProfile(
        "a Profile can only build on a Profile you can use",
      );
    }

    const chain = [under.id, ...this.#folders.buildsOn(under.id)];

    if (chain.includes(id)) {
      throw new InvalidProfile(`${under.name} already builds on this Profile`);
    }

    if (chain.length > maxBuildsOn) {
      throw new InvalidProfile(
        `a Profile can build on at most ${String(maxBuildsOn)} others`,
      );
    }

    return under.id;
  }

  #layer(userId: string, which: Layer): ProfileLayer | undefined {
    return which === "base"
      ? this.#folders.base
      : this.#folders.defaults(userId);
  }

  // Only admins change the base; everyone changes their own My defaults.
  #writable(
    userId: string,
    which: Layer,
    admin: boolean,
  ): Result<ProfileLayer> {
    const layer = this.#layer(userId, which);
    if (!layer) {
      return { ok: false, reason: "not_found" };
    }

    if (which === "base") {
      if (!admin) {
        return { ok: false, reason: "admin_only" };
      }

      this.#store.baseEdited(userId);
    }

    return { ok: true, value: layer };
  }

  #visible(userId: string, id: string): StoredProfile | undefined {
    const profile = this.#folders.read(id);

    return profile?.ownerId === null ||
      profile?.ownerId === teamOwner ||
      profile?.ownerId === userId
      ? profile
      : undefined;
  }

  #view(userId: string, profile: StoredProfile): Profile {
    return {
      ...profile,
      isDefault: this.#store.defaultProfileId(userId) === profile.id,
    };
  }
}

const teamOwner = "team";

function ownerOf(
  userId: string,
  team: boolean,
  shared: boolean,
): string | null {
  if (team) {
    return teamOwner;
  }

  return shared ? null : userId;
}

// Only admins change shared and team Profiles.
function mine(profile: StoredProfile, userId: string): boolean {
  return profile.ownerId === userId;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidProfile(`${exportFile} is not JSON`);
  }
}

function fieldsOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidProfile("body must be an object");
  }

  return value;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidProfile("name must be a non-empty string");
  }

  return value.trim();
}

function contentOf(fields: Record<string, unknown>): ProfileContent {
  const settings = objectOf("settings", fields["settings"]);
  if ("packages" in settings) {
    throw new InvalidProfile("settings can't hold packages; use packages");
  }

  return {
    packages: packagesOf(fields["packages"]),
    agentsMd: textOf("agentsMd", fields["agentsMd"]),
    systemMd: textOf("systemMd", fields["systemMd"]),
    appendSystemMd: textOf("appendSystemMd", fields["appendSystemMd"]),
    mcpServers: objectOf("mcpServers", fields["mcpServers"]),
    settings,
  };
}

function textOf(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new InvalidProfile(`${key} must be a string`);
  }

  return value;
}

function objectOf(key: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new InvalidProfile(`${key} must be an object`);
  }

  return value;
}

function packagesOf(value: unknown): readonly PiPackage[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new InvalidProfile("packages must be a list");
  }

  return value.map(packageOf);
}

const filters = ["extensions", "skills", "prompts", "themes"] as const;

function packageOf(value: unknown): PiPackage {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (
    !isRecord(value) ||
    typeof value["source"] !== "string" ||
    value["source"].trim() === ""
  ) {
    throw new InvalidProfile(
      "each package must be a source or an object with a source",
    );
  }

  const { autoload } = value;
  if (autoload !== undefined && typeof autoload !== "boolean") {
    throw new InvalidProfile("a package's autoload must be true or false");
  }

  const filtered = filters.flatMap((key) => {
    const list = value[key];
    if (list === undefined) {
      return [];
    }

    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      throw new InvalidProfile(`a package's ${key} must be a list of strings`);
    }

    return [[key, list] as const];
  });

  return {
    source: value["source"].trim(),
    ...(autoload !== undefined && { autoload }),
    ...Object.fromEntries(filtered),
  };
}

// The files of a folder in a clone, which must stay inside it.
function folderFiles(dir: string, path: string): ReadonlyMap<string, Buffer> {
  const folder = repositoryFolder(dir, path);

  return new Map(
    folderEntries(folder).map(({ path: file }) => [
      file,
      readFileSync(join(folder, file)),
    ]),
  );
}
