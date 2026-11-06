import type { JoinItem } from "@pipoca/protocol";
import {
  Avatar,
  Badge,
  Button,
  cn,
  ErrorText,
  Field,
  Hero,
  Icon,
  raisedCardClass,
  Row,
  Rows,
  SetupShell,
  Spinner,
  TextInput,
} from "@pipoca/ui";
import type { ReactElement, SubmitEvent } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";

// Where an invite's link lands someone who isn't signed in (ADR 0063).
export function JoinPage({ token }: { readonly token: string }): ReactElement {
  const invite = useQuery("auth.invite", { params: { token } });
  const info = invite.data ?? invite.error;

  const join = useAction(async (form: FormData) => {
    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    await request("auth.invite.accept", {
      params: { token },
      body: { name: text("name"), password: text("password") },
    });

    location.replace("/");
  });

  const error = join.error;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void join.run(new FormData(event.currentTarget));
  };

  return (
    <SetupShell
      aside={<span className="font-mono text-mono-sm">{location.host}</span>}
    >
      <main
        className={cn(
          "mx-auto flex w-full animate-rise-in gap-14 px-4 pt-10 pb-16 max-md:flex-col",
          typeof info === "object" && info.setUp.length + info.yours.length > 0
            ? "max-w-258"
            : "max-w-xl",
        )}
      >
        {info === undefined && <Spinner label="Loading…" />}
        {typeof info === "string" && (
          <Hero title="This invite doesn't work any more">{info}</Hero>
        )}
        {typeof info === "object" && (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <Avatar name={info.invitedBy} size="lg" />
              <div className="flex flex-col gap-2">
                <h1 className="font-serif text-hero leading-tight font-light text-fg-strong">
                  {info.invitedBy} invited you to{" "}
                  {info.team === null
                    ? "Pipoca"
                    : `the ${info.team} team's Pipoca`}
                </h1>
                <p className="text-prose text-fg-dim">
                  {info.logins.length > 0
                    ? "Sign in with your company account to join."
                    : "Make your account to join."}
                  {info.setUp.length > 0 &&
                    " Some of the setup is done for you, so you'll only add what's yours."}
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
                  className={cn(
                    raisedCardClass,
                    "flex max-w-sm flex-col gap-4 p-6",
                  )}
                >
                  <Field label="Username">
                    <TextInput
                      name="name"
                      required
                      autoComplete="username"
                      defaultValue={info.email?.split("@")[0] ?? ""}
                    />
                  </Field>
                  <Field label="Password" hint="At least 8 characters.">
                    <TextInput
                      name="password"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                    />
                  </Field>
                  <ErrorText size="caption">{error}</ErrorText>
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
            </div>
            {info.setUp.length + info.yours.length > 0 && (
              <aside className="flex flex-col gap-3 md:w-100 md:pt-16">
                {info.setUp.length > 0 && (
                  <Items label="Set up by your team" items={info.setUp} done />
                )}
                {info.yours.length > 0 && (
                  <Items label="You'll add" items={info.yours} />
                )}
              </aside>
            )}
          </>
        )}
      </main>
    </SetupShell>
  );
}

function Items({
  label,
  items,
  done = false,
}: {
  readonly label: string;
  readonly items: readonly JoinItem[];
  readonly done?: boolean;
}): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-label text-fg-dim">{label}</h2>
      <Rows label={label}>
        {items.map(({ title, summary, optional }) => (
          <Row
            key={title}
            leading={
              <span
                role="img"
                aria-label={done ? "Set up" : "To do"}
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full",
                  done ? "bg-done text-on-accent" : "border border-line-strong",
                )}
              >
                {done && <Icon name="check" className="size-3" />}
              </span>
            }
            title={
              <>
                {title}
                {optional && <Badge>Optional</Badge>}
              </>
            }
            description={summary}
          />
        ))}
      </Rows>
    </section>
  );
}
