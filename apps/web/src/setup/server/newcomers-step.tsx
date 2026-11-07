import type { Newcomers } from "@pipoca/protocol";
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Icon,
  plural,
  Row,
  Rows,
  Segmented,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../../data/client";
import { seed, useAction, useQuery } from "../../data/hooks";
import { useNewcomers } from "../../settings/people/newcomers";
import { packageText } from "../../settings/profiles/layers";
import { nameOf } from "../../settings/profiles/packages";
import { StepFooter } from "../footer";
import { personSteps } from "../steps";

// What someone who joins finds ready and which of their steps they can't
// skip (ADR 0072). A whole step is required or not, never a part of it.
export function NewcomersStep(): ReactElement {
  const newcomers = useNewcomers();

  const save = useAction(async (change: Partial<Newcomers>) => {
    seed(
      "settings.newcomers",
      await request("settings.newcomers.update", {
        body: { ...newcomers, ...change },
      }),
    );
  });

  return (
    <>
      <div className="grid items-start gap-5 md:grid-cols-2">
        <Preselected newcomers={newcomers} />
        <TheirSteps
          newcomers={newcomers}
          onChange={(change) => {
            void save.run(change);
          }}
        />
      </div>
      <ErrorText size="caption">{save.error}</ErrorText>
      <Invite />
      <StepFooter />
      <p className="-mt-4 text-right text-caption text-fg-dim">
        You go through the same steps next, with your answers above already
        filled in.
      </p>
    </>
  );
}

function Preselected({
  newcomers,
}: {
  readonly newcomers: Newcomers;
}): ReactElement {
  const templates = useQuery("environmentTemplates.list").data ?? [];
  const base = useQuery("settings.baseProfile").data;
  const template = templates.find(({ id }) => id === newcomers.template);

  const packages = (base?.packages ?? []).map((pkg) =>
    nameOf(packageText(pkg)),
  );

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-label font-medium text-fg-strong">
        Preselected for them
      </h2>
      <Rows label="Preselected for them">
        <Row
          leading={<Badge state="done">Picked</Badge>}
          title="Where Pi works"
          description={
            template === undefined
              ? "They connect a machine of their own"
              : `Their own ${template.runnersFrom?.label ?? template.name}`
          }
        />
        <Row
          leading={<Badge state="done">Always</Badge>}
          title="Server default Profile"
          description={
            packages.length === 0 ? "Pi's defaults" : packages.join(", ")
          }
        />
      </Rows>
    </section>
  );
}

function TheirSteps({
  newcomers,
  onChange,
}: {
  readonly newcomers: Newcomers;
  readonly onChange: (change: Partial<Newcomers>) => void;
}): ReactElement {
  const shared = (useQuery("profiles.list").data ?? []).filter(
    ({ ownerId }) => ownerId === null,
  );

  // Where Pi works shows on the left, as what the team picked for them.
  const theirs = personSteps().filter(({ id }) => id !== "where");

  const toggled = (list: readonly string[], id: string): readonly string[] =>
    list.includes(id) ? list.filter((each) => each !== id) : [...list, id];

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-label font-medium text-fg-strong">
        Their steps, from the plugins that are on
      </h2>
      <Rows label="Their steps">
        {theirs.map(({ id, step }) => (
          <Row
            key={id}
            className="md:flex-nowrap"
            title={
              <>
                {step.title}
                {id !== "profile" && (
                  <span className="font-mono text-caption font-normal text-fg-dim">
                    {id}
                  </span>
                )}
              </>
            }
            description={
              id === "profile" ? (
                <OfferedProfiles
                  offered={newcomers.profiles}
                  shared={shared}
                  onToggle={(profile) => {
                    onChange({
                      profiles: toggled(newcomers.profiles, profile),
                    });
                  }}
                />
              ) : (
                step.summary
              )
            }
          >
            {step.optional === true ? (
              <Segmented
                label={step.title}
                value={
                  newcomers.required.includes(id) ? "required" : "optional"
                }
                options={[
                  { value: "required", label: "Required" },
                  { value: "optional", label: "Optional" },
                ]}
                onChange={(value) => {
                  if (
                    (value === "required") !==
                    newcomers.required.includes(id)
                  ) {
                    onChange({ required: toggled(newcomers.required, id) });
                  }
                }}
              />
            ) : (
              <Badge>Required</Badge>
            )}
          </Row>
        ))}
      </Rows>
      <p className="text-caption text-fg-dim">
        Required means the whole step, never one provider or host. A plugin
        decides what done means for its own step.
      </p>
    </section>
  );
}

// The team Profiles new people may start their own default from.
function OfferedProfiles({
  offered,
  shared,
  onToggle,
}: {
  readonly offered: readonly string[];
  readonly shared: readonly { readonly id: string; readonly name: string }[];
  readonly onToggle: (id: string) => void;
}): ReactElement {
  if (shared.length === 0) {
    return <>Their own, from scratch or a folder</>;
  }

  return (
    <span className="flex flex-col gap-1.5">
      Can copy a team Profile:
      <span
        role="group"
        aria-label="Team Profiles they can copy"
        className="flex flex-wrap gap-1.5"
      >
        {shared.map(({ id, name }) => (
          <button
            key={id}
            type="button"
            aria-pressed={offered.includes(id)}
            onClick={() => {
              onToggle(id);
            }}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border border-line bg-elevated px-2.5 text-label text-fg-dim aria-pressed:text-fg"
          >
            {offered.includes(id) && <Icon name="check" className="size-3" />}
            {name}
          </button>
        ))}
      </span>
    </span>
  );
}

function Invite(): ReactElement {
  const [sent, setSent] = useState<string>();

  const invite = useAction(async (form: HTMLFormElement) => {
    const text = new FormData(form).get("emails");

    const emails = (typeof text === "string" ? text : "")
      .split(/[,\s]+/)
      .filter((email) => email !== "");

    setSent(undefined);
    const made = await request("invites.create", { body: { emails } });
    setSent(`Invited ${plural(made.length, "person", "people")}.`);
    form.reset();
  });

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void invite.run(event.currentTarget);
  };

  return (
    <form onSubmit={submit} aria-label="Invite people">
      <Field
        label="Invite people"
        hint={
          sent ??
          "Who may join without an invite is set by the sign-in plugin's step."
        }
        error={invite.error}
      >
        <div className="flex gap-2">
          <TextInput
            name="emails"
            required
            autoComplete="off"
            placeholder="Emails, separated by commas"
            className="flex-1"
          />
          <Button type="submit" disabled={invite.pending}>
            Send invites
          </Button>
        </div>
      </Field>
    </form>
  );
}
