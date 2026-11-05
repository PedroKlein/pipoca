import { Button, Field, fieldClass } from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useState,
} from "react";
import { api } from "./api";
import { Mark } from "./mark";

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
          className="flex flex-col gap-4 rounded-lg border border-line bg-elevated p-6 shadow-card"
        >
          <Field label="Name">
            <input
              name="name"
              required
              autoComplete="username"
              className={fieldClass}
            />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={fieldClass}
            />
          </Field>
          {error !== undefined && (
            <p role="alert" className="text-caption text-failed">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" className="h-10 w-full">
            Sign in
          </Button>
        </form>
      )}
    </Welcome>
  );
}

export function Welcome({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm animate-rise-in flex-col justify-center px-4 py-16">
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-8" />
          pipoca
        </span>
        <h1 className="font-serif text-display font-light text-fg-strong">
          {title}
        </h1>
        {description !== undefined && (
          <p className="text-label text-fg-dim">{description}</p>
        )}
      </div>
      {children}
    </main>
  );
}

const comingSteps = [
  { title: "Your account", summary: "You, as the server's admin" },
  {
    title: "Where Pi works",
    summary: "This computer, another machine or a cluster",
  },
  { title: "A model", summary: "Sign in with a subscription or add a key" },
  { title: "Your code", summary: "GitHub or another git host", optional: true },
  {
    title: "Your Profile",
    summary: "Bring your ~/.pi/agent or start fresh",
    optional: true,
  },
];

// The setup's first step: the first person makes their account, which
// becomes the admin (ADR 0063).
function SetupAccount({
  onSubmit,
  error,
}: {
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly error: string | undefined;
}): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-7 py-5">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-7" />
          pipoca
        </span>
        <ol aria-label="Setup steps" className="flex gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <li
              key={index}
              aria-current={index === 0 ? "step" : undefined}
              className={`h-0.75 w-9 rounded-full ${index === 0 ? "bg-fg-strong" : "bg-line"}`}
            />
          ))}
        </ol>
        <span className="justify-self-end text-label text-fg-dim">
          Step 1 of 6
        </span>
      </header>
      <main className="mx-auto grid w-full max-w-250 animate-rise-in gap-14 px-4 pt-8 pb-16 md:grid-cols-[1.5fr_1fr] md:pt-11">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-2">
            <h1 className="font-serif text-hero leading-tight font-light text-fg-strong">
              Welcome to Pipoca
            </h1>
            <p className="text-prose text-fg-dim">
              This server is brand new. Make your account first. It becomes the
              admin, so you can invite people later.
            </p>
          </div>
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-5 rounded-xl border border-line bg-elevated p-6 shadow-card"
          >
            <Field
              label="Username"
              hint="Shown on Sessions and Projects you start."
            >
              <input
                name="name"
                required
                autoComplete="username"
                className={fieldClass}
              />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <input
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                className={fieldClass}
              />
            </Field>
            {error !== undefined && (
              <p role="alert" className="text-caption text-failed">
                {error}
              </p>
            )}
            <Button
              variant="primary"
              type="submit"
              className="h-11 w-full text-prose"
            >
              Create account and continue
            </Button>
          </form>
        </div>
        <aside className="flex flex-col gap-3 md:pt-6">
          <h2 className="text-label text-fg-dim">
            What we'll set up, about 3 minutes
          </h2>
          <ol className="flex flex-col gap-1 rounded-xl border border-line bg-elevated p-4">
            {comingSteps.map(({ title, summary, optional }, index) => (
              <li key={title} className="flex items-center gap-3 py-2.5">
                <span
                  aria-hidden="true"
                  className={`grid size-6 shrink-0 place-items-center rounded-full border text-caption ${index === 0 ? "border-fg-strong text-fg-strong" : "border-line text-fg-dim"}`}
                >
                  {index + 1}
                </span>
                <span className="flex flex-col">
                  <span className="flex items-center gap-2 text-ui font-medium text-fg-strong">
                    {title}
                    {optional === true && (
                      <span className="inline-flex h-5 items-center rounded-full bg-hover px-2 text-caption font-medium text-fg-dim">
                        Optional
                      </span>
                    )}
                  </span>
                  <span className="text-label text-fg-dim">{summary}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="px-1 text-caption text-fg-dim">
            Everything here can be changed later in Settings.
          </p>
        </aside>
      </main>
    </div>
  );
}
