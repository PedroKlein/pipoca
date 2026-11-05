import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Hero,
  Mark,
  SetupShell,
  Step,
  Stepper,
  TextInput,
} from "@pipoca/ui";
import type { ReactElement, ReactNode, SubmitEvent } from "react";

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
export function SetupAccount({
  onSubmit,
  error,
}: {
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly error: string | undefined;
}): ReactElement {
  return (
    <SetupShell steps={{ total: 6, at: 0 }} aside="Step 1 of 6">
      <main className="mx-auto grid w-full max-w-258 animate-rise-in gap-14 px-4 pt-8 pb-16 md:grid-cols-[1.5fr_1fr] md:pt-11">
        <div className="flex flex-col gap-8">
          <Hero title="Welcome to Pipoca">
            This server is brand new. Make your account first. It becomes the
            admin, so you can invite people later.
          </Hero>
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-5 rounded-xl border border-line bg-elevated p-6 shadow-card"
          >
            <Field
              label="Username"
              hint="Shown on Sessions and Projects you start."
            >
              <TextInput name="name" required autoComplete="username" />
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
          <Card>
            <Stepper>
              {comingSteps.map(({ title, summary, optional }, index) => (
                <Step
                  key={title}
                  number={index + 1}
                  state={index === 0 ? "current" : "next"}
                  title={
                    <span className="flex items-center gap-2">
                      {title}
                      {optional === true && <Badge>Optional</Badge>}
                    </span>
                  }
                  description={summary}
                />
              ))}
            </Stepper>
          </Card>
          <p className="px-1 text-caption text-fg-dim">
            Everything here can be changed later in Settings.
          </p>
        </aside>
      </main>
    </SetupShell>
  );
}
