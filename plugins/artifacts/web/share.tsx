import { useApi, useLoaded, useViewer } from "@pipoca/plugins/web";
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Icon,
  Segmented,
  Select,
  TextInput,
  cn,
  popClass,
} from "@pipoca/ui";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView, Role, Share } from "../src/artifacts";
import { artifactHref } from "./collaborate";

const listedMost = 8;

interface Teammate {
  readonly id: string;
  readonly name: string;
  readonly here?: boolean;
}

// Who opens the artifact, which only people who steer it change. Pi can't.
// What it saves outlives the dialog closing, so it opens again on the
// newest list even before the artifact reloads.
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
  const api = useApi(plugin);
  const [shares, setShares] = useState<readonly Share[]>(artifact.shares);
  const [problem, setProblem] = useState<string>();
  const [pending, setPending] = useState(0);

  // What the artifact last loaded, and whether it came after the last save,
  // so it may be newer than what this dialog shows.
  const [loaded, setLoaded] = useState({
    shares: artifact.shares,
    fresh: false,
  });

  const [wasOpen, setWasOpen] = useState(open);

  if (loaded.shares !== artifact.shares) {
    setLoaded({ shares: artifact.shares, fresh: true });
  }

  if (open !== wasOpen) {
    setWasOpen(open);

    if (!open) {
      setProblem(undefined);
    }

    if (open && pending === 0 && loaded.fresh) {
      setLoaded({ ...loaded, fresh: false });
      setShares(loaded.shares);
    }
  }

  // Saves go one at a time, so the server keeps the last change, and only
  // the newest one's refusal shows and goes back to what was saved.
  const queue = useRef(Promise.resolve());
  const saved = useRef(artifact.shares);
  const newest = useRef(0);
  const refused = useRef(0);

  const save = async (next: readonly Share[]): Promise<boolean> => {
    const mine = ++newest.current;

    if (pending === 0) {
      saved.current = shares;
    }

    setPending((count) => count + 1);
    setProblem(undefined);
    setShares(next);

    const done = queue.current.then(async () =>
      api.put(`artifacts/${artifact.id}/shares`, {
        shares: next.map(({ name, role }) => ({ name, role })),
      }),
    );

    queue.current = done.then(
      () => undefined,
      () => undefined,
    );

    try {
      await done;
      saved.current = next;

      return true;
    } catch (error) {
      if (mine !== newest.current) {
        return true;
      }

      refused.current = mine;
      setShares(saved.current);

      setProblem(
        `Couldn't save who has access: ${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    } finally {
      setPending((count) => count - 1);
      setLoaded((last) => ({ ...last, fresh: false }));
    }
  };

  // Done closes once every save is in, staying open only to show a refusal
  // that came in while it waited.
  const done = async (): Promise<void> => {
    const before = refused.current;
    let waited: Promise<void>;

    do {
      waited = queue.current;
      await waited;
    } while (waited !== queue.current);

    if (refused.current === before || refused.current !== newest.current) {
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Share “${artifact.title}”`}
      size="lg"
      sheet
      initialFocus="input[role=combobox]"
    >
      <ShareForm
        artifact={artifact}
        version={version}
        shares={shares}
        problem={problem}
        save={save}
        onDone={done}
      />
    </Dialog>
  );
}

function ShareForm({
  artifact,
  version,
  shares,
  problem,
  save,
  onDone,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly shares: readonly Share[];
  readonly problem: string | undefined;
  readonly save: (next: readonly Share[]) => Promise<boolean>;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const { person } = useViewer();
  const team = artifact.audience === "team";
  const [fixed, setFixed] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const accessId = useId();

  const link = `${location.origin}${location.pathname}${artifactHref(
    artifact.id,
    fixed ? version : undefined,
  )}`;

  const yours = artifact.owner === person.name;

  return (
    <>
      <DialogBody>
        {team ? (
          <p className="text-label text-fg">
            Everyone on the team opens it, because it comes from team work.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <PersonSearch
                input={search}
                taken={[person.id, ...shares.map(({ userId }) => userId)]}
                owner={artifact.owner}
                onAdd={async (added, role) =>
                  save([
                    ...shares,
                    { userId: added.id, name: added.name, role },
                  ])
                }
              />
              <ErrorText size="caption">{problem}</ErrorText>
            </div>
            <section className="flex flex-col">
              <h3
                id={accessId}
                className="mb-1 text-label font-medium text-fg-strong"
              >
                People with access
              </h3>
              <ul aria-labelledby={accessId} className="flex flex-col">
                <PersonRow
                  name={yours ? `${artifact.owner} (you)` : artifact.owner}
                  avatar={artifact.owner}
                  detail={
                    yours && artifact.sessionId !== null
                      ? "The Session is yours"
                      : undefined
                  }
                >
                  <span className="text-label text-fg-dim">Owner</span>
                </PersonRow>
                {shares.map((share) => (
                  <PersonRow key={share.userId} name={share.name}>
                    <Select
                      aria-label={`Role for ${share.name}`}
                      className="w-37.5"
                      value={share.role}
                      onChange={(event) => {
                        const role = event.target.value as Role;

                        void save(
                          shares.map((each) =>
                            each === share ? { ...each, role } : each,
                          ),
                        );
                      }}
                    >
                      <option value="comment">Can comment</option>
                      <option value="view">Can view</option>
                    </Select>
                    <Button
                      variant="ghost"
                      iconOnly
                      aria-label={`Remove ${share.name}`}
                      title={`Remove ${share.name}`}
                      onClick={() => {
                        search.current?.focus();
                        void save(shares.filter((each) => each !== share));
                      }}
                    >
                      <Icon name="x" className="size-3.5" />
                    </Button>
                  </PersonRow>
                ))}
              </ul>
            </section>
          </>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-label font-medium text-fg-strong">
            The link opens
          </span>
          <div>
            <Segmented
              label="The link opens"
              value={fixed ? "fixed" : "latest"}
              options={[
                { value: "latest", label: "The latest version" },
                { value: "fixed", label: `Version ${String(version)} only` },
              ]}
              onChange={(value) => {
                setFixed(value === "fixed");
              }}
            />
          </div>
        </div>
        <p className="flex gap-2.5 rounded-lg bg-hover px-3.5 py-3 text-label text-fg">
          <Icon name="info" className="mt-0.5 shrink-0 text-fg-dim" />
          <span>
            {team
              ? ""
              : `${whoSends(shares, artifact.sessionId !== null, yours)} `}
            Every viewer signs in to Pipoca; there are no public links.
          </span>
        </p>
      </DialogBody>
      <DialogFoot>
        <span className="mr-auto">
          <CopyLink text={link} />
        </span>
        <Button
          variant="primary"
          onClick={() => {
            void onDone();
          }}
        >
          Done
        </Button>
      </DialogFoot>
    </>
  );
}

function whoSends(
  shares: readonly Share[],
  session: boolean,
  yours: boolean,
): string {
  const commenters = shares
    .filter(({ role }) => role === "comment")
    .map(({ name }) => name);

  const sender = yours ? "you" : "people who act in its Session";

  const sending = session
    ? `Only ${sender} can send threads to Pi, with Send to Pi in the comments or by writing @pi.`
    : "No one can send its threads to Pi, because it has no Session.";

  if (commenters.length > 0) {
    return `Comments from ${listOf(commenters)} stay between people. ${sending}`;
  }

  return shares.length > 0
    ? `People you add can read it and can't send threads to Pi.`
    : sending;
}

function listOf(names: readonly string[]): string {
  const last = names.at(-1) ?? "";

  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${last}`
    : last;
}

function PersonRow({
  name,
  avatar = name,
  detail,
  children,
}: {
  readonly name: string;
  readonly avatar?: string;
  readonly detail?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li className="flex min-h-13 items-center gap-3 border-t border-line py-2 first:border-t-0">
      <Avatar name={avatar} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-fg-strong">
          {name}
        </span>
        {detail !== undefined && (
          <span className="truncate text-caption text-fg-dim">{detail}</span>
        )}
      </span>
      {children}
    </li>
  );
}

// Only people who sign in on this server can be added, never a typed name.
function PersonSearch({
  input,
  taken,
  owner,
  onAdd,
}: {
  readonly input: RefObject<HTMLInputElement | null>;
  readonly taken: readonly string[];
  readonly owner: string;
  readonly onAdd: (person: Teammate, role: Role) => Promise<boolean>;
}): ReactElement {
  const api = useApi(plugin);
  const listId = useId();
  const [text, setText] = useState("");
  const [listing, setListing] = useState(false);
  const [active, setActive] = useState(0);
  const [role, setRole] = useState<Role>("comment");

  const { value: everyone } = useLoaded(
    async () =>
      api
        .get<readonly Teammate[]>("/api/people")
        .catch(() => "failed" as const),
    "artifacts:share-people",
  );

  const candidates =
    everyone === undefined || everyone === "failed"
      ? []
      : everyone.filter(
          ({ id, name }) => !taken.includes(id) && name !== owner,
        );

  const query = text.trim().toLowerCase();
  const open = listing && query !== "";
  const matches = open ? ranked(candidates, query) : [];
  const current = Math.min(active, matches.length - 1);
  const chosen = candidates.find(({ name }) => name.toLowerCase() === query);

  const pick = (name: string): void => {
    setText(name);
    setListing(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];

    if (step !== undefined && !open && query !== "") {
      event.preventDefault();
      setListing(true);
      setActive(0);

      return;
    }

    if (!open) {
      return;
    }

    const option = matches[current];

    if (event.key === "Escape") {
      event.preventDefault();
      setListing(false);
    }

    if (option === undefined) {
      return;
    }

    if (step !== undefined) {
      event.preventDefault();
      setActive((current + step + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(option.name);
    }
  };

  const unlisted = (): string => {
    if (everyone === undefined) {
      return "Loading the people on this server…";
    }

    return everyone === "failed"
      ? "The people on this server didn't load. Close Share and open it again."
      : `No one called “${text.trim()}” signs in here.`;
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (chosen === undefined) {
          setListing(true);

          return;
        }

        input.current?.focus();
        setText("");

        void onAdd(chosen, role).then((added) => {
          if (!added) {
            setText((now) => (now === "" ? chosen.name : now));
          }
        });
      }}
    >
      <div className="relative min-w-0 flex-1 max-sm:basis-full">
        <TextInput
          ref={input}
          role="combobox"
          aria-label="Add people"
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          aria-controls={matches.length > 0 ? listId : undefined}
          aria-activedescendant={
            matches.length > 0 ? `${listId}-${String(current)}` : undefined
          }
          autoComplete="off"
          placeholder="Add people by name"
          className="w-full"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setListing(true);
            setActive(0);
          }}
          onKeyDown={keyDown}
          onBlur={() => {
            setListing(false);
          }}
        />
        {open && (
          <div
            className={cn(
              popClass,
              "absolute inset-x-0 top-full z-10 mt-1.5 flex flex-col p-1.5",
            )}
          >
            <span
              id={`${listId}-label`}
              className="px-2.5 pt-1.5 pb-1 text-caption font-medium text-fg-strong"
            >
              People on this Pipoca server
            </span>
            {matches.length > 0 ? (
              <ul
                id={listId}
                role="listbox"
                aria-labelledby={`${listId}-label`}
                className="flex flex-col"
              >
                {matches.map((match, index) => (
                  <li
                    key={match.id}
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={index === current}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5",
                      index === current && "bg-fg/10",
                    )}
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(match.name);
                    }}
                  >
                    <Avatar name={match.name} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-label font-medium text-fg-strong">
                        {match.name}
                      </span>
                      {match.here === true && (
                        <span className="text-caption text-fg-dim">
                          Online now
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="px-2.5 py-2 text-label text-fg-dim">
                {unlisted()}
              </p>
            )}
            <p className="mx-2.5 mt-1 border-t border-line pt-2 pb-1 text-caption text-fg-dim">
              Only people who sign in here can be added. To add someone new, an
              admin invites them first.
            </p>
          </div>
        )}
      </div>
      <Select
        aria-label="Role for new people"
        className="w-35 max-sm:flex-1"
        value={role}
        onChange={(event) => {
          setRole(event.target.value as Role);
        }}
      >
        <option value="comment">Can comment</option>
        <option value="view">Can view</option>
      </Select>
      <Button type="submit" variant="primary" disabled={chosen === undefined}>
        Add
      </Button>
    </form>
  );
}

function ranked(
  candidates: readonly Teammate[],
  query: string,
): readonly Teammate[] {
  const rank = (name: string): number => {
    const lower = name.toLowerCase();

    if (lower === query) {
      return -1;
    }

    if (lower.startsWith(query)) {
      return 0;
    }

    if (lower.split(/\s+/).some((word) => word.startsWith(query))) {
      return 1;
    }

    return lower.includes(query) ? 2 : 3;
  };

  return candidates
    .map((candidate) => ({ candidate, at: rank(candidate.name) }))
    .filter(({ at }) => at < 3)
    .sort((one, other) => one.at - other.at)
    .map(({ candidate }) => candidate)
    .slice(0, listedMost);
}

function CopyLink({ text }: { readonly text: string }): ReactElement {
  const [said, setSaid] = useState<string>();

  const say = (words: string): void => {
    setSaid(words);

    setTimeout(() => {
      setSaid(undefined);
    }, 2000);
  };

  return (
    <Button
      variant="ghost"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            say("Copied");
          },
          () => {
            say("Couldn't copy");
          },
        );
      }}
    >
      <Icon name={said === "Copied" ? "check" : "link"} className="size-3.5" />
      <span aria-live="polite">{said ?? "Copy link"}</span>
    </Button>
  );
}
