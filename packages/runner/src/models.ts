import type { Log, ModelRef } from "@pipoca/protocol";
import {
  type ListedModels,
  modelLister,
  type SessionOptions,
} from "@pipoca/sessionhost";

const relistMs = 60_000;

export interface Logins {
  readonly authPath: string;
  readonly modelsPath: string;
}

// The machine's models, and those of providers its Profiles' packages add,
// each agent folder listed apart.
export interface MachineModels {
  readonly models: () => readonly ModelRef[];
  readonly registered: () => readonly ModelRef[];
  // False when the folder was listed already.
  readonly add: (agentDir: string) => boolean;
  readonly forget: (agentDir: string) => void;
  readonly relist: () => Promise<void>;
  // A login in any of its Sessions adds models to the machine (ADR 0024), so
  // they are listed again now and then until the signal aborts.
  readonly follow: (signal: AbortSignal) => () => void;
}

export function machineModels(options: {
  readonly logins: Logins;
  readonly extensionPaths: readonly string[];
  readonly models?: SessionOptions["models"];
  readonly log: Log;
}): MachineModels {
  const { log } = options;
  const listers = new Map<string, Promise<() => Promise<ListedModels>>>();
  let models: readonly ModelRef[] = [];
  let registered: readonly ModelRef[] = [];
  let listings = 0;

  const relist = async (): Promise<void> => {
    // A slower, older listing may still hold a deleted Profile's models.
    const listing = ++listings;

    const lists = await Promise.all(
      [...listers.values()].map(async (lister) =>
        (await lister)().catch((error: unknown): ListedModels => {
          log("models not listed", { error: String(error) });

          return { available: [], registered: [] };
        }),
      ),
    );

    const listed = unique(lists.flatMap(({ available }) => available));
    const all = unique(lists.flatMap((list) => list.registered));

    if (listing !== listings) {
      return;
    }

    if (listed.length !== models.length || all.length !== registered.length) {
      log("models listed", { count: listed.length, registered: all.length });
    }

    models = listed;
    registered = all;
  };

  return {
    models: () => models,
    registered: () => registered,
    add: (agentDir) => {
      if (listers.has(agentDir)) {
        return false;
      }

      listers.set(
        agentDir,
        modelLister({
          agentDir,
          ...options.logins,
          extensionPaths: options.extensionPaths,
          ...(options.models && { models: options.models }),
        }).catch((error: unknown) => {
          log("models not listed", { agentDir, error: String(error) });

          return async (): Promise<ListedModels> =>
            Promise.resolve({ available: [], registered: [] });
        }),
      );

      return true;
    },
    forget: (agentDir) => {
      listers.delete(agentDir);
    },
    relist,
    follow: (signal) => {
      const relisting = setInterval(() => {
        void relist();
      }, relistMs);

      const stop = (): void => {
        clearInterval(relisting);
      };

      signal.addEventListener("abort", stop);

      return stop;
    },
  };
}

function unique(all: readonly ModelRef[]): readonly ModelRef[] {
  return [
    ...new Map(
      all.map((model) => [`${model.provider}/${model.id}`, model]),
    ).values(),
  ];
}
