import {
  Button,
  cn,
  ErrorText,
  Field,
  raisedCardClass,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../api";
import { Welcome, SetupAccount } from "./setup-account";

// Another way in that a plugin offers, such as single sign-on (ADR 0038).
export interface Login {
  readonly label: string;
  readonly path: string;
}

// The desktop app's window signs in through the person's browser, since
// some identity providers refuse an embedded one (ADR 0055).
const inDesktopApp = "pipocaDesktop" in window;

// The first user comes from the one-time link in the server's log (ADR 0034).
export function SignInPage({
  setup,
  setupToken: linkToken,
  logins,
  passwordLogin,
  solo,
}: {
  // No user exists yet.
  readonly setup: boolean;
  readonly setupToken: string | undefined;
  readonly logins: readonly Login[];
  readonly passwordLogin: boolean;
  readonly solo: boolean;
}): ReactElement {
  const [error, setError] = useState<string>();
  const setupToken = setup ? linkToken : undefined;

  if (solo) {
    return (
      <Welcome
        title="Sign in from your machine"
        description="Run pipoca link --open where the server runs. It opens Pipoca here, signed in."
      />
    );
  }

  if (setup && setupToken === undefined) {
    return (
      <Welcome
        title="No users yet"
        description="Open the setup link from the server's log to create the first user."
      />
    );
  }

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const credentials = { name: text("name"), password: text("password") };

    void (async () => {
      try {
        await (setupToken === undefined
          ? api("auth.session.create", { body: credentials })
          : api("auth.setup", { body: { ...credentials, token: setupToken } }));

        location.replace("/");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "");
      }
    })();
  };

  if (setupToken !== undefined) {
    return <SetupAccount onSubmit={submit} error={error} />;
  }

  return (
    <Welcome title="Sign in">
      {inDesktopApp && (
        <div className="mb-4 flex flex-col gap-2">
          <Button
            variant="primary"
            onClick={() => {
              location.assign(
                `pipoca://sign-in?server=${encodeURIComponent(location.origin)}`,
              );
            }}
          >
            Sign in with your browser
          </Button>
        </div>
      )}
      {!inDesktopApp && logins.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {logins.map(({ label, path }) => (
            <Button
              key={path}
              variant="primary"
              onClick={() => {
                location.assign(path);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {passwordLogin && (
        <form
          onSubmit={submit}
          className={cn(raisedCardClass, "flex flex-col gap-4 p-6")}
        >
          <Field label="Name">
            <TextInput name="name" required autoComplete="username" />
          </Field>
          <Field label="Password">
            <TextInput
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <ErrorText size="caption">{error}</ErrorText>
          <Button variant="primary" type="submit" className="h-10 w-full">
            Sign in
          </Button>
        </form>
      )}
    </Welcome>
  );
}
