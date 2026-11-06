import { defineWeb, useApi, useLoaded } from "@pipoca/plugins/web";
import type { Environment } from "@pipoca/protocol";
import {
  Button,
  Card,
  cn,
  ErrorText,
  Field,
  fieldClass,
  Section,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { local } from "../plugin";
import {
  defaultSettings,
  type LocalEnvironment,
  type RunnerFailure,
} from "../src/settings";

export const web = defineWeb(local, {
  slots: { "environment.section": EnvironmentSection },
});

function EnvironmentSection({
  environment,
}: {
  readonly environment: Environment;
}): ReactElement {
  const api = useApi(local);
  const path = `environments/${encodeURIComponent(environment.id)}`;

  const { value, reload } = useLoaded(
    async () => api.get<LocalEnvironment>(path),
    path,
    { everyMs: 10_000 },
  );

  return (
    <Section title="Local runner">
      <Card
        padding="none"
        aria-label="Local runner"
        className="flex flex-col gap-4 p-5 text-ui"
      >
        {value === undefined ? (
          <p className="text-fg-dim">Loading…</p>
        ) : (
          <>
            {value.lastFailure !== null && (
              <Failure failure={value.lastFailure} />
            )}
            <Settings
              key={JSON.stringify(value.settings)}
              loaded={value}
              save={async (settings) => {
                await api.post(path, { settings });
                reload();
              }}
            />
          </>
        )}
      </Card>
    </Section>
  );
}

function Failure({
  failure,
}: {
  readonly failure: RunnerFailure;
}): ReactElement {
  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString([], { timeStyle: "short" });

  return (
    <ErrorText size="inherit">
      The runner failed at {time(failure.at)}: {failure.problem}. The next one
      starts after {time(failure.retryAt)}, and the server log says why.
    </ErrorText>
  );
}

function Settings({
  loaded,
  save,
}: {
  readonly loaded: LocalEnvironment;
  readonly save: (settings: object | null) => Promise<void>;
}): ReactElement {
  const shown = loaded.settings ?? defaultSettings;
  const [error, setError] = useState<string>();
  const on = loaded.settings !== null;

  const run = (settings: object | null): void => {
    save(settings).then(
      () => {
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    run({
      capacity: Number(text("capacity")),
      idleSeconds: Number(text("idleSeconds")),
      folders: text("folders")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-fg-dim">
        {on
          ? "The server starts a runner on its own machine when a Session here needs one, and stops it when idle."
          : "Off. The server can start a runner on its own machine when a Session here needs one."}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sessions at once">
          <TextInput
            name="capacity"
            type="number"
            min={1}
            required
            defaultValue={shown.capacity}
          />
        </Field>
        <Field label="Seconds idle before it stops">
          <TextInput
            name="idleSeconds"
            type="number"
            min={1}
            required
            defaultValue={shown.idleSeconds}
          />
        </Field>
      </div>
      <Field label="Folders Sessions can work in, one per line">
        <textarea
          name="folders"
          rows={3}
          defaultValue={shown.folders.join("\n")}
          placeholder="~/code"
          className={cn(fieldClass, "min-h-20 resize-y font-mono text-mono-sm")}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit">
          {on ? "Save" : "Run on this machine"}
        </Button>
        {on && (
          <Button
            onClick={() => {
              run(null);
            }}
          >
            Stop running here
          </Button>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    </form>
  );
}
