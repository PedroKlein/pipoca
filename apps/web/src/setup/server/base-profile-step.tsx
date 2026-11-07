import type { SetupStepProps } from "@pipoca/plugins/web";
import type { PiPackage, ProfileContent } from "@pipoca/protocol";
import {
  Button,
  Code,
  ErrorText,
  Field,
  Icon,
  initialsOf,
  Notice,
  Row,
  Rows,
  TextArea,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../../data/client";
import { seed, useAction, useQuery } from "../../data/hooks";
import { packageText } from "../../settings/profiles/layers";
import { nameOf } from "../../settings/profiles/packages";

export async function baseProfileDone(): Promise<boolean> {
  const base = await request("settings.baseProfile");

  return base.packages.length > 0 || base.agentsMd !== "";
}

// The server default Profile, under every Session (ADR 0044), and on a
// team server the team Profiles that team Sessions run with (ADR 0072).
export function BaseProfileStep({ solo }: SetupStepProps): ReactElement {
  const base = useQuery("settings.baseProfile").data;

  const save = useAction(async (change: Partial<ProfileContent>) => {
    seed(
      "settings.baseProfile",
      await request("settings.baseProfile.update", { body: change }),
    );
  });

  if (base === undefined) {
    return <></>;
  }

  return (
    <>
      <AddPackage
        onAdd={async (source) =>
          save.run({ packages: [...base.packages, source] })
        }
      />
      <Rows label="Server default Profile">
        {base.packages.map((pkg, index) => (
          <PackageRow
            key={`${packageText(pkg)}:${String(index)}`}
            pkg={pkg}
            onRemove={() => {
              void save.run({
                packages: base.packages.filter((_each, n) => n !== index),
              });
            }}
          />
        ))}
        <Instructions
          text={base.agentsMd}
          onSave={async (agentsMd) => save.run({ agentsMd })}
        />
      </Rows>
      <ErrorText size="caption">{save.error}</ErrorText>
      {!solo && <TeamProfiles />}
      <Notice>
        Packages install on each runner the first time a Session there needs
        them. Saved under <Code>base/</Code> in the config folder.
      </Notice>
    </>
  );
}

function AddPackage({
  onAdd,
}: {
  readonly onAdd: (source: string) => Promise<unknown>;
}): ReactElement {
  const [source, setSource] = useState("");

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (source.trim() !== "") {
      void onAdd(source.trim()).then(() => {
        setSource("");
      });
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add a package">
      <Field
        label="Add a package"
        hint="An npm name, a git URL or a path, as Pi's settings take it."
      >
        <div className="flex gap-2">
          <TextInput
            name="source"
            value={source}
            placeholder="npm:pi-subagents or git:…"
            className="flex-1 font-mono text-mono-sm"
            onChange={(event) => {
              setSource(event.target.value);
            }}
          />
          <Button type="submit">Add</Button>
        </div>
      </Field>
    </form>
  );
}

function PackageRow({
  pkg,
  onRemove,
}: {
  readonly pkg: PiPackage;
  readonly onRemove: () => void;
}): ReactElement {
  const source = typeof pkg === "string" ? pkg : pkg.source;
  const name = nameOf(source);

  return (
    <Row
      initials={initialsOf(name)}
      title={name}
      description={<span className="font-mono">{source}</span>}
    >
      <Button
        variant="ghost"
        iconOnly
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <Icon name="x" />
      </Button>
    </Row>
  );
}

function Instructions({
  text,
  onSave,
}: {
  readonly text: string;
  readonly onSave: (text: string) => Promise<unknown>;
}): ReactElement {
  const [draft, setDraft] = useState<string>();

  return (
    <Row
      initials="Md"
      title="Team instructions"
      description={
        draft === undefined ? (
          `AGENTS.md for every Session. ${text === "" ? "Empty." : firstLine(text)}`
        ) : (
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();

              void onSave(draft).then(() => {
                setDraft(undefined);
              });
            }}
          >
            <TextArea
              aria-label="Team instructions"
              value={draft}
              rows={4}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <span className="flex gap-2">
              <Button type="submit" variant="primary" size="sm">
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(undefined);
                }}
              >
                Cancel
              </Button>
            </span>
          </form>
        )
      }
    >
      {draft === undefined && (
        <Button
          size="sm"
          onClick={() => {
            setDraft(text);
          }}
        >
          {text === "" ? "Write" : "Edit"}
        </Button>
      )}
    </Row>
  );
}

// Concrete Profiles for team Sessions, on the server default and never on
// anyone's own default (ADR 0064).
function TeamProfiles(): ReactElement {
  const shared = (useQuery("profiles.list").data ?? []).filter(
    ({ ownerId }) => ownerId === null,
  );

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const add = useAction(async () => {
    await request("profiles.create", { body: { name, shared: true } });
    setName("");
    setNaming(false);
  });

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-label font-medium text-fg-strong">
        Team Profiles{" "}
        <span className="font-normal text-fg-dim">
          · what team Sessions run with, on top of this default
        </span>
      </h2>
      <Rows label="Team Profiles">
        {shared.map((profile) => (
          <Row
            key={profile.id}
            initials={initialsOf(profile.name)}
            title={profile.name}
            description={
              profile.agentsMd === ""
                ? "A Profile the team shares"
                : firstLine(profile.agentsMd)
            }
          />
        ))}
        <Row
          initials="+"
          title="New team Profile"
          description={
            naming ? (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void add.run();
                }}
              >
                <TextInput
                  aria-label="Team Profile name"
                  required
                  value={name}
                  placeholder="Backend"
                  className="flex-1"
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
                <Button type="submit" variant="primary">
                  Add
                </Button>
              </form>
            ) : (
              "Its skills, tools and instructions, edited in Team setup"
            )
          }
        >
          {!naming && (
            <Button
              size="sm"
              onClick={() => {
                setNaming(true);
              }}
            >
              Add
            </Button>
          )}
        </Row>
      </Rows>
      <ErrorText size="caption">{add.error}</ErrorText>
    </section>
  );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line !== "") ?? ""
  );
}
