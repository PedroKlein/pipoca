import { useApi } from "@pipoca/plugins/web";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Icon,
  Radio,
  Segmented,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView, Role } from "../src/artifacts";
import { artifactHref } from "./collaborate";

// Who opens the artifact, which only people who steer it change. Pi can't.
export function ShareDialog({
  artifact,
  version,
  open,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Share “${artifact.title}”`}
      size="md"
    >
      <ShareForm artifact={artifact} version={version} onClose={onClose} />
    </Dialog>
  );
}

function ShareForm({
  artifact,
  version,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const team = artifact.audience === "team";
  const [named, setNamed] = useState(artifact.shares.length > 0);
  const [people, setPeople] = useState(artifact.shares.map(({ name }) => name));
  const [name, setName] = useState("");

  const [role, setRole] = useState<Role>(
    artifact.shares.some((each) => each.role === "comment")
      ? "comment"
      : "view",
  );

  const [fixed, setFixed] = useState(false);
  const [problem, setProblem] = useState<string>();

  const add = (): void => {
    const trimmed = name.trim();

    if (trimmed !== "" && !people.includes(trimmed)) {
      setPeople([...people, trimmed]);
    }

    setName("");
  };

  const save = async (): Promise<void> => {
    setProblem(undefined);

    try {
      await api.put(`artifacts/${artifact.id}/shares`, {
        shares: named ? people.map((each) => ({ name: each, role })) : [],
      });

      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const link = `${location.origin}${location.pathname}${artifactHref(
    artifact.id,
    fixed ? version : undefined,
  )}`;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogBody>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-label font-medium text-fg-strong">
            Who can open it
          </legend>
          {team ? (
            <p className="text-label text-fg-dim">
              Everyone on the team, because it comes from team work.
            </p>
          ) : (
            <>
              <Radio
                name="audience"
                label="Only you"
                description="The default for personal work. A Project's people see its Sessions too."
                checked={!named}
                onChange={() => {
                  setNamed(false);
                }}
              />
              <Radio
                name="audience"
                label="You and people you name"
                description="Anyone with a Pipoca account on this server"
                checked={named}
                onChange={() => {
                  setNamed(true);
                }}
              />
            </>
          )}
        </fieldset>
        {named && !team && (
          <div className="flex flex-col gap-2">
            <span className="text-label font-medium text-fg-strong">
              People
            </span>
            {people.length > 0 && (
              <ul aria-label="People" className="flex flex-wrap gap-1.5">
                {people.map((each) => (
                  <li
                    key={each}
                    className="inline-flex items-center gap-1 rounded-full bg-hover py-0.5 pr-1 pl-2.5 text-label"
                  >
                    {each}
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Stop sharing with ${each}`}
                      onClick={() => {
                        setPeople(people.filter((one) => one !== each));
                      }}
                    >
                      <Icon name="x" className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <TextInput
                aria-label="Name"
                placeholder="Add a name…"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                  }
                }}
              />
              <Button
                variant="default"
                disabled={name.trim() === ""}
                onClick={add}
              >
                Add
              </Button>
            </div>
            <div className="flex items-center gap-3 text-label">
              They can
              <Segmented
                label="Access"
                value={role}
                options={[
                  { value: "view", label: "View" },
                  { value: "comment", label: "Comment" },
                ]}
                onChange={setRole}
              />
            </div>
            {role === "comment" && (
              <p className="text-caption text-fg-dim">
                People who comment can reply in threads but can&apos;t send them
                to Pi. Only people who can act in the Session do.
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-label font-medium text-fg-strong">Link</span>
          <div className="flex items-center gap-3 text-label">
            The link opens
            <Segmented
              label="Version"
              value={fixed ? "fixed" : "latest"}
              options={[
                { value: "latest", label: "Latest version" },
                { value: "fixed", label: `Version ${String(version)} only` },
              ]}
              onChange={(value) => {
                setFixed(value === "fixed");
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-hover px-2 py-1 font-mono text-mono">
              {link}
            </code>
            <CopyLink label="Copy link" text={link} />
          </div>
          <p className="text-caption text-fg-dim">
            Only people allowed above can open it. There are no public links;
            everyone signs in.
          </p>
        </div>
        <ErrorText size="caption">{problem}</ErrorText>
      </DialogBody>
      <DialogFoot>
        <span className="mr-auto text-caption text-fg-dim">
          Pi can&apos;t change who opens an artifact.
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={team}>
          Save
        </Button>
      </DialogFoot>
    </form>
  );
}

function CopyLink({
  label,
  text,
}: {
  readonly label: string;
  readonly text: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="default"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);

          setTimeout(() => {
            setCopied(false);
          }, 2000);
        });
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
