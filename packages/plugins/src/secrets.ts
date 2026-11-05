import { BadRequest, isObject } from "./http";
import type { PluginStore } from "./plugin";

// A secret in pipoca.json: sealed with the server's key, as Settings saves
// it, or named by an environment variable, for config kept in Git (ADR 0039).
export type SecretRef = { readonly sealed: string } | { readonly env: string };

export interface SecretRefs {
  // The ref in a config field and the secret it names, or throws with why
  // it can't be read.
  readonly open: (
    value: unknown,
    context: string,
    field: string,
  ) => { readonly ref: SecretRef; readonly secret: string };
  readonly seal: (secret: string, context: string) => SecretRef;
}

export type EnvSecrets = (name: string) => string | undefined;

// Sessions the server starts inherit its environment, so a secret leaves it
// once read, and later reads find it here. One per server.
export function envSecrets(env: NodeJS.ProcessEnv): EnvSecrets {
  const read = new Map<string, string>();

  return (name) => {
    const secret = env[name] ?? read.get(name);

    if (secret === undefined || secret === "") {
      return undefined;
    }

    read.set(name, secret);
    Reflect.deleteProperty(env, name);

    return secret;
  };
}

export function secretRefs(
  store: Pick<PluginStore, "seal" | "open">,
  fromEnv: EnvSecrets,
): SecretRefs {
  return {
    open: (value, context, field) => {
      if (isObject(value) && typeof value["env"] === "string") {
        const name = value["env"];
        const secret = fromEnv(name);

        if (secret === undefined) {
          throw new BadRequest(
            `${field} names the environment variable ${name}, which isn't set`,
          );
        }

        return { ref: { env: name }, secret };
      }

      if (isObject(value) && typeof value["sealed"] === "string") {
        const sealed = value["sealed"];

        try {
          return { ref: { sealed }, secret: store.open(sealed, context) };
        } catch {
          throw new BadRequest(
            `${field} isn't sealed with this server's key; save it in Settings or name an environment variable`,
          );
        }
      }

      throw new BadRequest(`${field} must be { "sealed": … } or { "env": … }`);
    },
    seal: (secret, context) => ({ sealed: store.seal(secret, context) }),
  };
}
