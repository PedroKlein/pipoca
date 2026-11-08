import { ago, href, useApi, useLoaded, useNow } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Icon,
  Notice,
  Page,
  Radio,
  Segmented,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type ArtifactView,
  kindLabel,
  type Role,
} from "../src/artifacts";
import { base, Comments, Compare, Editor, Frame } from "./collaborate";

export type Rail = "versions" | "comments";

// One artifact in its sandboxed frame, with its versions or its comments
// beside it.
export function ArtifactPage({
  id,
  version,
  rail: shownRail = "versions",
}: {
  readonly id: string;
  readonly version: number | undefined;
  readonly rail?: Rail;
}): ReactElement {
  const api = useApi(plugin);
  const now = useNow();

  const { value: artifact } = useLoaded(
    async () => api.get<ArtifactView>(`artifacts/${id}`),
    id,
    { changes: ["artifacts"] },
  );

  const { value: comments } = useLoaded(
    async () =>
      (
        await api.get<{ comments: { quote: string; parent: string | null }[] }>(
          `artifacts/${id}/comments`,
        )
      ).comments,
    `${id}:quotes`,
    { changes: ["artifacts"] },
  );

  const [problem, setProblem] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [rail, setRail] = useState<Rail>(shownRail);
  const [quote, setQuote] = useState("");
  const [sharing, setSharing] = useState(false);

  if (artifact === undefined) {
    return <Page title="Artifact">{null}</Page>;
  }

  const shown = version ?? artifact.versions;
  const latest = shown === artifact.versions;
  const query = `?v=${String(shown)}`;

  const quotes = (comments ?? [])
    .filter((each) => each.parent === null && each.quote !== "")
    .map((each) => each.quote);

  const restore = async (): Promise<void> => {
    setProblem(undefined);

    try {
      await api.post(`artifacts/${id}/restore`, { version: shown });
      location.hash = href(plugin, id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Page
      wide
      title={artifact.title}
      description={<Origin artifact={artifact} />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            aria-pressed={artifact.pinned}
            onClick={() =>
              void api.put(`artifacts/${id}/pin`, { pinned: !artifact.pinned })
            }
          >
            <Icon name="pin" className="size-3.5" />
            {artifact.pinned ? "Pinned" : "Pin"}
          </Button>
          <Button
            variant="ghost"
            aria-pressed={rail === "comments"}
            onClick={() => {
              setRail(rail === "comments" ? "versions" : "comments");
            }}
          >
            {`Comments ${String(artifact.openComments)}`}
          </Button>
          {artifact.access === "steer" && (
            <Button
              variant="default"
              onClick={() => {
                setSharing(true);
              }}
            >
              Share
            </Button>
          )}
          <a
            href={`${base}/artifacts/${id}/download${query}`}
            className="text-label text-accent hover:underline"
          >
            Download
          </a>
          <a
            href={`${base}/artifacts/${id}/view${query}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            className="text-fg-dim hover:text-fg"
          >
            <Icon name="external-link" className="size-4" />
          </a>
        </div>
      }
    >
      {!latest && (
        <Notice
          action={
            <div className="flex items-center gap-2">
              <a
                href={href(plugin, id)}
                className="text-label text-accent hover:underline"
              >
                Back to latest
              </a>
              {artifact.access === "steer" && (
                <Button variant="default" onClick={() => void restore()}>
                  Restore version {shown}
                </Button>
              )}
            </div>
          }
        >
          You&apos;re looking at <b>version {shown}</b>. People with the link
          see version {artifact.versions} unless the link names a version.
        </Notice>
      )}
      <ErrorText size="caption">{problem}</ErrorText>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3">
          {artifact.kind === "markdown" &&
            artifact.access === "steer" &&
            latest && (
              <Segmented
                label="Mode"
                value={editing ? "edit" : "read"}
                options={[
                  { value: "read", label: "Read" },
                  { value: "edit", label: "Edit" },
                ]}
                onChange={(mode) => {
                  setEditing(mode === "edit");
                }}
              />
            )}
          {editing ? (
            <Editor
              artifact={artifact}
              onDone={() => {
                setEditing(false);
              }}
            />
          ) : (
            <Frame
              artifact={artifact}
              version={shown}
              highlights={quotes}
              onSelect={(text) => {
                setQuote(text);
                setRail("comments");
              }}
            />
          )}
          <p className="text-caption text-fg-dim">
            {artifact.kind === "markdown" || artifact.kind === "csv"
              ? "Select text to comment on it. "
              : ""}
            Shown in a sandbox: scripts run, but the page can&apos;t reach
            Pipoca or your sign-in.
          </p>
        </div>
        <aside
          aria-label={rail === "versions" ? "Versions" : "Comments"}
          className="flex min-w-0 flex-col gap-4"
        >
          <Segmented
            label="Beside the artifact"
            value={rail}
            options={[
              { value: "versions", label: "Versions" },
              {
                value: "comments",
                label: `Comments ${String(artifact.openComments)}`,
              },
            ]}
            onChange={setRail}
          />
          {rail === "versions" ? (
            <Versions artifact={artifact} shown={shown} now={now} />
          ) : (
            <Comments
              artifact={artifact}
              version={shown}
              quote={quote}
              onQuoted={() => {
                setQuote("");
              }}
            />
          )}
        </aside>
      </div>
      <ShareDialog
        artifact={artifact}
        version={shown}
        open={sharing}
        onClose={() => {
          setSharing(false);
        }}
      />
    </Page>
  );
}

// Whose it is, the Session it came from, and who opens it.
export function Origin({
  artifact,
}: {
  readonly artifact: ArtifactSummary;
}): ReactElement {
  return (
    <span>
      {artifact.owner}
      {artifact.sessionId !== null && (
        <>
          {" · from "}
          <a href={`#${artifact.sessionId}`} className="hover:underline">
            {artifact.sessionTitle ?? "its Session"}
          </a>
        </>
      )}
      {` · ${audienceLabel(artifact)}`}
    </span>
  );
}

export function audienceLabel(artifact: ArtifactSummary): string {
  if (artifact.audience === "team") {
    return "Team";
  }

  if (artifact.audience === "named") {
    return `Shared with ${artifact.sharedWith.join(", ")}`;
  }

  return artifact.yours ? "Only you" : `From ${artifact.owner}`;
}

export function versionHref(id: string, number: number, last: number): string {
  return number === last
    ? href(plugin, id)
    : href(plugin, `${id}/v/${String(number)}`);
}

function Versions({
  artifact,
  shown,
  now,
}: {
  readonly artifact: ArtifactView;
  readonly shown: number;
  readonly now: number;
}): ReactElement {
  const [comparing, setComparing] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-dim">Every publish is kept.</p>
      <ol aria-label="Versions" className="flex flex-col gap-1">
        {[...artifact.history].reverse().map((each) => (
          <li key={each.number}>
            <a
              href={versionHref(artifact.id, each.number, artifact.versions)}
              aria-current={each.number === shown ? "page" : undefined}
              className={cn(
                "flex flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-hover",
                each.number === shown && "bg-hover",
              )}
            >
              <span className="flex items-center gap-2 text-label font-medium text-fg-strong">
                Version {each.number}
                {each.number === artifact.versions && <Badge>latest</Badge>}
                {each.number === shown && each.number !== artifact.versions && (
                  <Badge>viewing</Badge>
                )}
              </span>
              <span className="text-caption text-fg-dim">
                {[
                  each.by,
                  ago(new Date(each.createdAt).toISOString(), now),
                  ...(each.note === "" ? [] : [each.note]),
                ].join(" · ")}
              </span>
            </a>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {artifact.versions > 1 && (
          <Button
            variant="default"
            aria-pressed={comparing}
            onClick={() => {
              setComparing(!comparing);
            }}
          >
            Compare
          </Button>
        )}
        <CopyLink
          label={`Copy link to version ${String(shown)}`}
          text={`${location.origin}${location.pathname}${href(plugin, `${artifact.id}/v/${String(shown)}`)}`}
        />
      </div>
      {comparing && <Compare artifact={artifact} version={shown} narrow />}
    </div>
  );
}

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

  const link = `${location.origin}${location.pathname}${
    fixed
      ? href(plugin, `${artifact.id}/v/${String(version)}`)
      : href(plugin, artifact.id)
  }`;

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
                A comment can go to Pi as the person&apos;s message, so people
                who comment steer the Session.
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

export function galleryLine(artifact: ArtifactSummary, now: number): string {
  return [
    kindLabel(artifact.kind),
    `v${String(artifact.versions)}`,
    ago(new Date(artifact.updatedAt).toISOString(), now),
  ].join(" · ");
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
