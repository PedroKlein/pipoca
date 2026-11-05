import type { JoinInfo } from "@pipoca/protocol";
import { Avatar, Button, Field, fieldClass, Hero, SetupShell, Spinner } from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useState,
} from "react";
import { api } from "./api";

// Where an invite's link lands someone who isn't signed in (ADR 0063).
export function JoinPage({ token }: { readonly token: string }): ReactElement {
  const [info, setInfo] = useState<JoinInfo | string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch(`/api/auth/join/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = (await response.json()) as JoinInfo & {
          readonly message?: string;
        };

        setInfo(response.ok ? body : (body.message ?? "This invite is gone."));
      })
      .catch(() => {
        setInfo("The server can't be reached. Reload to try again.");
      });
  }, [token]);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    api(`/api/auth/join/${encodeURIComponent(token)}`, {
      name: text("name"),
      password: text("password"),
    }).then(
      () => {
        location.replace("/");
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <SetupShell
      aside={<span className="font-mono text-mono-sm">{location.host}</span>}
    >
      <main className="mx-auto flex w-full max-w-xl animate-rise-in flex-col gap-6 px-4 pt-10 pb-16">
        {info === undefined && <Spinner label="Loading…" />}
        {typeof info === "string" && (
          <>
            <Hero title="This invite doesn't work any more">{info}</Hero>
          </>
        )}
        {typeof info === "object" && (
          <>
            <Avatar name={info.invitedBy} size="lg" />
            <div className="flex flex-col gap-2">
              <h1 className="font-serif text-hero leading-tight font-light text-fg-strong">
                {info.invitedBy} invited you to Pipoca
              </h1>
              <p className="text-prose text-fg-dim">
                {info.logins.length > 0
                  ? "Sign in with your company account to join."
                  : "Make your account to join."}
                {info.admin && " You'll be an admin."}
              </p>
            </div>
            {info.logins.map(({ label, path }) => (
              <Button
                key={path}
                variant="primary"
                className="h-11 w-full max-w-sm"
                onClick={() => {
                  location.assign(path);
                }}
              >
                {label}
              </Button>
            ))}
            {info.passwordLogin && (
              <form
                onSubmit={submit}
                aria-label="Make your account"
                className="flex max-w-sm flex-col gap-4 rounded-lg border border-line bg-elevated p-6 shadow-card"
              >
                <Field label="Username">
                  <input
                    name="name"
                    required
                    autoComplete="username"
                    defaultValue={info.email?.split("@")[0] ?? ""}
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
                <Button variant="primary" type="submit" className="h-10">
                  Join
                </Button>
              </form>
            )}
            <p className="text-caption text-fg-dim">
              {info.passwordLogin
                ? ""
                : "This server only allows company sign-in. "}
              The invite expires on{" "}
              {new Date(info.expiresAt).toLocaleDateString([], {
                day: "numeric",
                month: "long",
              })}
              .
            </p>
          </>
        )}
      </main>
    </SetupShell>
  );
}
