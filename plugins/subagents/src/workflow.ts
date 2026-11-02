import { readFile } from "node:fs/promises";
import { type JSValueHandle, QuickJS } from "quickjs-wasi";
import wasm from "quickjs-wasi/quickjs.wasm" with { type: "file" };

export interface WorkflowStep {
  readonly key?: string;
  readonly agent: string;
  readonly task: string;
}

// What a script can do with the run it belongs to.
export interface WorkflowHost {
  // A step's output; fails when the step doesn't end done.
  readonly run: (step: WorkflowStep) => Promise<string>;
  readonly steer: (key: string, message: string) => Promise<boolean>;
  // Whether the run was stopped, so the script stops too.
  readonly stopped: () => boolean;
}

export interface WorkflowResult {
  readonly output: string;
  readonly error?: string;
}

const memoryLimit = 64 * 1024 * 1024;
// How long a script may compute without awaiting a step.
const busyMs = 10_000;

let compiled: Promise<WebAssembly.Module> | undefined;

// Runs a workflow script in QuickJS, the sandbox Pi's codemode uses (ADR
// 0058). It sees only runs, args and console: no files, shell or network.
export async function runWorkflow(
  source: string,
  args: unknown,
  host: WorkflowHost,
): Promise<WorkflowResult> {
  compiled ??= readFile(wasm).then(async (bytes) => WebAssembly.compile(bytes));

  let busySince = Date.now();
  let checks = 0;

  const vm = await QuickJS.create({
    wasm: await compiled,
    memoryLimit,
    interruptHandler: () => {
      checks += 1;
      if (checks % 10_000 !== 0) {
        return false;
      }

      return host.stopped() || Date.now() - busySince > busyMs;
    },
  });

  const logged: string[] = [];

  // Runs guest code, counting the time it computes.
  const guest = <T>(work: () => T): T => {
    busySince = Date.now();

    return work();
  };

  // A host promise as a guest promise, settled with JSON to keep values plain.
  const promised = (work: () => Promise<unknown>): JSValueHandle => {
    const deferred = vm.newPromise();

    work().then(
      (value) => {
        if (host.stopped()) {
          deferred.reject(vm.newError("The run was stopped."));
        } else {
          deferred.resolve(vm.hostToHandle(value ?? null));
        }

        guest(() => vm.executePendingJobs());
      },
      (error: unknown) => {
        deferred.reject(
          vm.newError(error instanceof Error ? error.message : String(error)),
        );

        guest(() => vm.executePendingJobs());
      },
    );

    return deferred.handle;
  };

  const step = (value: unknown): WorkflowStep => {
    const { key, agent, task } = (value ?? {}) as Readonly<
      Record<string, unknown>
    >;

    if (typeof agent !== "string" || typeof task !== "string") {
      throw new Error("runs.run takes { agent, task } and an optional key.");
    }

    return { ...(typeof key === "string" && { key }), agent, task };
  };

  try {
    const runs = vm.newObject();

    const functions = {
      run: vm.newFunction("runsRun", (value) =>
        promised(async () => host.run(step(vm.dump(value)))),
      ),
      all: vm.newFunction("runsAll", (value) =>
        promised(async () => {
          const steps = vm.dump(value);
          if (!Array.isArray(steps)) {
            throw new Error("runs.all takes an array of steps.");
          }

          return Promise.all(steps.map(async (s) => host.run(step(s))));
        }),
      ),
      steer: vm.newFunction("runsSteer", (key, message) =>
        promised(async () =>
          host.steer(String(vm.dump(key)), String(vm.dump(message))),
        ),
      ),
    };

    for (const [name, fn] of Object.entries(functions)) {
      vm.setProp(runs, name, fn);
      fn.dispose();
    }

    vm.setProp(vm.global, "runs", runs);
    runs.dispose();

    const log = vm.newFunction("consoleLog", (...values) => {
      logged.push(values.map((v) => text(vm.dump(v))).join(" "));

      return vm.undefined;
    });

    const console = vm.newObject();
    vm.setProp(console, "log", log);
    vm.setProp(vm.global, "console", console);
    log.dispose();
    console.dispose();

    const passed = vm.hostToHandle(args ?? null);
    vm.setProp(vm.global, "args", passed);
    passed.dispose();

    const promise = guest(() =>
      vm.evalCode(`(async () => {\n${source}\n})()`, "workflow.js"),
    );

    guest(() => vm.executePendingJobs());

    const settled = await vm.resolvePromise(promise);
    promise.dispose();

    const output = [...logged];

    if ("error" in settled) {
      const error = vm.dump(settled.error);
      settled.error.dispose();

      return {
        output: output.join("\n"),
        error: messageOf(error),
      };
    }

    const value = vm.dump(settled.value);
    settled.value.dispose();

    if (value !== undefined && value !== null) {
      output.push(text(value));
    }

    return { output: output.join("\n") };
  } catch (error) {
    return {
      output: logged.join("\n"),
      error: messageOf(error),
    };
  } finally {
    vm.dispose();
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const { message } = (error ?? {}) as { readonly message?: unknown };

  return typeof message === "string" ? message : text(error);
}
