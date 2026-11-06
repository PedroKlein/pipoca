import {
  BadRequest,
  type Collection,
  isHttpError,
  NotFound,
  type Static,
  Type,
} from "@pipoca/plugins";
import type { ProviderItem } from "../plugin";
import type { ProviderView } from "./model";

// What Settings sends to add or change a provider. An empty or missing client
// secret keeps the one the provider has, and null takes it away.
export const providerChange = Type.Object({
  label: Type.Optional(Type.String()),
  issuer: Type.Optional(Type.String()),
  clientId: Type.Optional(Type.String()),
  clientSecret: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  groupsClaim: Type.Optional(Type.String()),
  accessGroup: Type.Optional(Type.String()),
  adminGroup: Type.Optional(Type.String()),
  allowedEmails: Type.Optional(Type.Array(Type.String())),
  allowedDomains: Type.Optional(Type.Array(Type.String())),
  adminEmails: Type.Optional(Type.Array(Type.String())),
});

type ProviderChange = Static<typeof providerChange>;

// A provider as the plugin uses it. Lists are lower case.
export interface ProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  // Undefined for a public client, which PKCE alone protects.
  readonly clientSecret: string | undefined;
  readonly groupsClaim: string;
  readonly accessGroup: string;
  readonly adminGroup: string;
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly adminEmails: readonly string[];
}

export interface Providers {
  readonly list: () => readonly ProviderConfig[];
  readonly get: (id: string) => ProviderConfig | undefined;
  readonly create: (input: ProviderChange) => ProviderConfig;
  readonly update: (id: string, input: ProviderChange) => ProviderConfig;
  readonly remove: (id: string) => void;
}

const defaultGroupsClaim = "groups";
const defaultLabel = "Sign in with single sign-on";

// The providers live in the plugin's config in pipoca.json, which Settings
// and people both edit (ADR 0039).
export function providers(items: Collection<ProviderItem>): Providers {
  const get = (id: string): ProviderConfig | undefined => {
    const item = items.get(id);

    return item && configOf(item);
  };

  // kept is the secret the provider keeps unless Settings typed another.
  const save = (input: ProviderChange, id: string, kept?: string): void => {
    const typed = input.clientSecret?.trim() ?? "";

    try {
      items.put(itemOf(checked(id, input), typed === "" ? kept : typed));
    } catch (failure) {
      if (isHttpError(failure)) {
        throw failure;
      }

      throw new BadRequest(
        failure instanceof Error ? failure.message : String(failure),
      );
    }
  };

  const found = (id: string): ProviderConfig => {
    const provider = get(id);

    if (provider === undefined) {
      throw new NotFound(`no provider ${id}`);
    }

    return provider;
  };

  return {
    list: () => items.list().map(configOf),
    get,
    create: (input) => {
      const id = freeId(
        input.label,
        new Set(items.list().map((each) => each.id)),
      );

      save(input, id);

      return found(id);
    },
    update: (id, input) => {
      const { clientSecret } = found(id);

      save(input, id, input.clientSecret === null ? undefined : clientSecret);

      return found(id);
    },
    remove: (id) => {
      if (!items.remove(id)) {
        throw new NotFound(`no provider ${id}`);
      }
    },
  };
}

// The web never gets a client secret back, only whether one is set.
export function viewOf(
  { clientSecret, ...provider }: ProviderConfig,
  signedInThisWeek: number,
): ProviderView {
  return {
    ...provider,
    hasClientSecret: clientSecret !== undefined,
    signedInThisWeek,
  };
}

function checked(id: string, input: ProviderChange): ProviderConfig {
  const { clientSecret: _secret, ...fields } = input;

  const provider = configOf({
    ...fields,
    id,
    issuer: input.issuer ?? "",
    clientId: input.clientId ?? "",
  });

  if (!URL.canParse(provider.issuer)) {
    throw new BadRequest("issuer must be a URL");
  }

  if (provider.clientId === "") {
    throw new BadRequest("clientId is needed");
  }

  return provider;
}

function configOf(item: ProviderItem): ProviderConfig {
  const text = (value = "", fallback = ""): string =>
    value.trim() === "" ? fallback : value.trim();

  const list = (values: readonly string[] = []): readonly string[] =>
    values.flatMap((each) =>
      each.trim() === "" ? [] : [each.trim().toLowerCase()],
    );

  return {
    id: item.id,
    label: text(item.label, defaultLabel),
    issuer: text(item.issuer),
    clientId: text(item.clientId),
    clientSecret: item.clientSecret,
    groupsClaim: text(item.groupsClaim, defaultGroupsClaim),
    accessGroup: text(item.accessGroup),
    adminGroup: text(item.adminGroup),
    allowedEmails: list(item.allowedEmails),
    allowedDomains: list(item.allowedDomains),
    adminEmails: list(item.adminEmails),
  };
}

// What the file holds for a provider, leaving out what is empty or default.
function itemOf(
  provider: ProviderConfig,
  clientSecret: string | undefined,
): ProviderItem {
  const kept = Object.entries({
    ...provider,
    label: provider.label === defaultLabel ? "" : provider.label,
    groupsClaim:
      provider.groupsClaim === defaultGroupsClaim ? "" : provider.groupsClaim,
    clientSecret,
  }).filter(
    ([, value]) =>
      value !== undefined &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0),
  );

  return Object.fromEntries(kept) as unknown as ProviderItem;
}

// A readable id for the file, such as "sap" for "Sign in with SAP".
function freeId(label: string | undefined, taken: ReadonlySet<string>): string {
  const base =
    (label ?? "")
      .toLowerCase()
      .replace(/^sign in with\s+/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "provider";

  let id = base;
  for (let n = 2; taken.has(id); n++) {
    id = `${base}-${String(n)}`;
  }

  return id;
}
