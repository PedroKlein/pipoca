import { logins } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  cn,
  ErrorText,
  Field,
  fieldClass,
  Select,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Connectable, Connection, ConnectionPrompt } from "../src/model";

type Send = (call: Promise<unknown>) => void;

// Picks a provider and a way in, and asks the server to sign the person in.
// With a provider it signs in to that one, and with a layer it keeps the
// login there, such as one Profile's own (ADR 0063). An admin may instead
// keep an API key on the server base, for everyone.
export function ConnectForm({
  send,
  onClose,
  provider: fixed,
  layer,
  admin = false,
}: {
  readonly send: Send;
  readonly onClose: () => void;
  readonly provider?: string;
  readonly layer?: string;
  readonly admin?: boolean;
}): ReactElement | null {
  const api = useApi(logins);

  const { value: providers } = useLoaded(
    async () => api.get<readonly Connectable[]>("providers"),
    "providers",
  );

  const [providerId, setProviderId] = useState(fixed);
  const [chosenLayer, setChosenLayer] = useState(layer ?? "defaults");

  if (providers === undefined) {
    return null;
  }

  const provider =
    providers.find(({ id }) => id === providerId) ?? providers[0];

  const methods =
    provider?.methods.filter(
      ({ type }) => chosenLayer !== "base" || type === "api_key",
    ) ?? [];

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    if (provider?.paste === true) {
      send(
        api.post("save", {
          provider: provider.id,
          credential: { type: "api_key", key: form.get("key") },
          layer: chosenLayer,
        }),
      );

      return;
    }

    send(
      api.post("connect", {
        provider: provider?.id,
        type: form.get("type"),
        layer: chosenLayer,
      }),
    );
  };

  return (
    <form
      aria-label={`Connect ${fixed === undefined ? "a model provider" : (provider?.name ?? fixed)}`}
      onSubmit={connect}
      className={cn(cardClass, "flex flex-col gap-3 p-3")}
    >
      {fixed === undefined && (
        <Field label="Provider">
          <Select
            value={provider?.id}
            onChange={(event) => {
              setProviderId(event.target.value);
            }}
          >
            {providers.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {admin && layer === undefined && (
        <Field label="For">
          <Select
            value={chosenLayer}
            onChange={(event) => {
              setChosenLayer(event.target.value);
            }}
          >
            <option value="defaults">Me, in every Profile</option>
            <option value="base">Everyone, on the server base</option>
          </Select>
        </Field>
      )}
      {provider?.paste === true ? (
        <Field label="Key">
          <textarea
            name="key"
            required
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className={`${fieldClass} font-mono`}
          />
        </Field>
      ) : (
        <Field label="Log in with">
          <Select key={`${provider?.id ?? ""}:${chosenLayer}`} name="type">
            {methods.map(({ type, label }) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={methods.length === 0}>
          Connect
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

// Shows the sign-in the server runs for the person: links to open, codes to
// enter and Pi's prompts, until it's done.
export function ConnectionCard({
  connection,
  send,
}: {
  readonly connection: Connection;
  readonly send: Send;
}): ReactElement {
  const api = useApi(logins);

  const { name } = connection;

  const dismiss = (): void => {
    send(api.delete("connection"));
  };

  return (
    <section
      aria-label={`Connecting ${name}`}
      className={cn(cardClass, "flex flex-col gap-3 p-3 text-ui")}
    >
      <p className="font-medium text-fg">
        {connection.state === "done"
          ? `Connected to ${name}.`
          : `Connecting ${name}`}
      </p>
      {connection.events.map((event, index) => (
        <ConnectionEvent key={index} event={event} />
      ))}
      {connection.prompt !== undefined && (
        <PromptForm
          key={connection.prompt.id}
          prompt={connection.prompt}
          send={send}
        />
      )}
      {connection.state === "failed" && (
        <ErrorText size="caption">
          {connection.error ?? "The sign-in didn't finish."}
        </ErrorText>
      )}
      <div>
        <Button onClick={dismiss}>
          {connection.state === "running" ? "Cancel" : "Close"}
        </Button>
      </div>
    </section>
  );
}

function ConnectionEvent({
  event,
}: {
  readonly event: Connection["events"][number];
}): ReactElement {
  switch (event.type) {
    case "auth_url":
      return (
        <p className="flex flex-col gap-1 text-fg">
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent underline"
          >
            Open the sign-in page
          </a>
          {event.instructions !== undefined && (
            <span className="text-fg-dim">{event.instructions}</span>
          )}
        </p>
      );
    case "device_code":
      return (
        <p className="flex flex-col gap-1 text-fg">
          <span>
            Enter the code{" "}
            <code className="font-mono font-medium">{event.userCode}</code> on{" "}
            <a
              href={event.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent underline"
            >
              the sign-in page
            </a>
            .
          </span>
        </p>
      );
    case "info":
      return (
        <p className="flex flex-col gap-1 text-fg-dim">
          {event.message}
          {event.links?.map(({ url, label }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              {label ?? url}
            </a>
          ))}
        </p>
      );
    case "progress":
      return <p className="text-fg-dim">{event.message}</p>;
  }
}

function PromptForm({
  prompt,
  send,
}: {
  readonly prompt: ConnectionPrompt;
  readonly send: Send;
}): ReactElement {
  const api = useApi(logins);

  const answer = (value: unknown): void => {
    send(api.post("connection/answer", { prompt: prompt.id, answer: value }));
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    answer(new FormData(event.currentTarget).get("answer"));
  };

  return (
    <form
      aria-label={prompt.message}
      onSubmit={submit}
      className="flex flex-col gap-2"
    >
      <Field label={prompt.message}>
        {prompt.type === "select" ? (
          <Select name="answer">
            {prompt.options?.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        ) : (
          <input
            name="answer"
            type={prompt.type === "secret" ? "password" : "text"}
            autoComplete="off"
            placeholder={prompt.placeholder}
            className={fieldClass}
          />
        )}
      </Field>
      <div>
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </div>
    </form>
  );
}
