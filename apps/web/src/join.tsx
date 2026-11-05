import { ApiError, type JoinInfo } from "@pipoca/protocol";
import { Button, Field, fieldClass, initialsOf } from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useState,
} from "react";
import { api } from "./api";
import { Mark } from "./mark";

// Where an invite's link lands someone who isn't signed in (ADR 0063).
export function JoinPage({ token }: { readonly token: string }): ReactElement {
  const [info, setInfo] = useState<JoinInfo | string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api("auth.invite", { params: { token } })
      .then(setInfo)
      .catch((reason: unknown) => {
        setInfo(
          reason instanceof ApiError
            ? reason.message
            : "The server can't be reached. Reload to try again.",
        );
      });
  }, [token]);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    api("auth.invite.accept", {
      params: { token },
      body: { name: text("name"), password: text("password") },
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
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-7 py-5">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-7" />
          pipoca
        </span>
        <span className="font-mono text-mono-sm text-fg-dim">
          {location.host}
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-xl animate-rise-in flex-col gap-6 px-4 pt-10 pb-16">
        {info === undefined && <p className="text-fg-dim">Loading…</p>}
        {typeof info === "string" && (
          <>
            <h1 className="font-serif text-hero leading-tight font-light text-fg-strong">
              This invite doesn&apos;t work any more
            </h1>
            <p className="text-prose text-fg-dim">{info}</p>
          </>
        )}
        {typeof info === "object" && (
          <>
            <span
              aria-hidden="true"
              className="grid size-11 place-items-center rounded-full bg-hover text-prose font-semibold text-fg-strong"
            >
              {initialsOf(info.invitedBy)}
            </span>
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
    </div>
  );
}
