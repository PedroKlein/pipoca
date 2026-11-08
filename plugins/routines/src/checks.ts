import { readFile } from "node:fs/promises";
import type { DeclaredCheck } from "@pipoca/protocol";
import { QuickJS } from "quickjs-wasi";
import wasm from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { Value } from "typebox/value";
import type { Routine, Trigger } from "./routine";

// A check computes for at most this long, sees this many earlier firings
// of its piece of work, and has little memory (ADR 0075).
const limitMs = 50;
export const earlierSeen = 10;
const memoryLimit = 8 * 1024 * 1024;

export interface Checked {
  readonly passed: boolean;
  readonly error?: string;
}

// What a trigger's check runs: its own script, or a plugin's with the
// settings the trigger gives it.
export interface CheckScript {
  readonly script: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

let compiled: Promise<WebAssembly.Module> | undefined;

// Runs the script in QuickJS, as workflows do (ADR 0058), with no files or
// network: it sees event, earlier and settings, and returns true or false.
// Anything else, an error or running past the limit counts as false.
export async function runCheck(
  { script, settings }: CheckScript,
  event: unknown,
  earlier: readonly unknown[],
): Promise<Checked> {
  compiled ??= readFile(wasm).then(async (bytes) => WebAssembly.compile(bytes));

  let deadline = Number.POSITIVE_INFINITY;

  const vm = await QuickJS.create({
    wasm: await compiled,
    memoryLimit,
    interruptHandler: () => performance.now() > deadline,
  });

  try {
    for (const [name, value] of Object.entries({ event, earlier, settings })) {
      const handle = vm.hostToHandle(value);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    }

    deadline = performance.now() + limitMs;

    const result = vm.evalCode(`(function () {\n${script}\n})()`, "check.js");
    const value: unknown = vm.dump(result);
    result.dispose();

    return typeof value === "boolean"
      ? { passed: value }
      : {
          passed: false,
          error: `the check returned ${value === undefined ? "nothing" : JSON.stringify(value)}, not true or false`,
        };
  } catch (error) {
    return {
      passed: false,
      error:
        performance.now() > deadline
          ? `the check ran past its ${String(limitMs)} ms`
          : `the check failed: ${messageOf(error)}`,
    };
  } finally {
    vm.dispose();
  }
}

// The script a trigger's check runs, finding a plugin's check by its type
// or its name alone. An Error says what is wrong with it.
export function checkScriptOf(
  trigger: Trigger,
  declared: readonly DeclaredCheck[],
): CheckScript | undefined {
  const check = "check" in trigger ? trigger.check : undefined;

  if (check === undefined) {
    return undefined;
  }

  if (typeof check === "string") {
    return { script: check, settings: {} };
  }

  const exact = declared.find(({ type }) => type === check.use);

  const byName = declared.filter(
    ({ type }) => type.slice(type.indexOf(".") + 1) === check.use,
  );

  const found = exact ?? (byName.length === 1 ? byName[0] : undefined);

  if (found === undefined) {
    throw new Error(
      byName.length > 1
        ? `check ${check.use}: name one of ${byName.map(({ type }) => type).join(", ")}`
        : `check ${check.use}: no plugin that is on offers this check`,
    );
  }

  const settings = check.with ?? {};

  if (found.settings !== undefined && !Value.Check(found.settings, settings)) {
    const [error] = Value.Errors(found.settings, settings);
    const at = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

    throw new Error(
      `check ${check.use}: ${at === "" ? "with" : `with.${at}`} ${error?.message ?? "doesn't fit"}`,
    );
  }

  return { script: found.script, settings };
}

// Each trigger's check names a check that is there with settings that fit.
export function checkChecks(
  routine: Routine,
  declared: readonly DeclaredCheck[],
): void {
  for (const [index, each] of routine.when.entries()) {
    try {
      checkScriptOf(each, declared);
    } catch (error) {
      throw new Error(`when.${String(index)}: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const { message } = (error ?? {}) as { message?: unknown };

  return typeof message === "string" ? message : String(error);
}
