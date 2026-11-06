import type { Session } from "@pipoca/protocol";
import {
  Button,
  Dialog,
  ErrorText,
  Field,
  Icon,
  Notice,
  Select,
  TextArea,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { command, request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import type { FeedItem } from "./feed";
import { href, navigate } from "../router";

const handoff =
  "Write a handoff summary of this work for my team, who will carry it on in a new Session without this conversation: the goal, what is done, what is left, decisions made and why, and where things are in the repository. Leave out secrets and anything personal. Reply with the summary only.";

// Personal work moves to the team as a new Session that starts from a
// summary the person edits, never the transcript (ADR 0067).
export function MoveDialog({
  session,
  items,
  busy,
  open,
  onClose,
}: {
  readonly session: Session;
  readonly items: readonly FeedItem[];
  readonly busy: boolean;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="move-title" size="md">
      <MoveForm session={session} items={items} busy={busy} onDone={onClose} />
    </Dialog>
  );
}

function MoveForm({
  session,
  items,
  busy,
  onDone,
}: {
  readonly session: Session;
  readonly items: readonly FeedItem[];
  readonly busy: boolean;
  readonly onDone: () => void;
}): ReactElement {
  const team = { query: { scope: "team" } } as const;
  const environments = useQuery("environments.list", team).data ?? [];
  const profiles = useQuery("profiles.list", team).data ?? [];
  const [environmentPick, setEnvironment] = useState("");
  const [profilePick, setProfile] = useState("");
  const environment = environmentPick || (environments[0]?.id ?? "");
  const profile = profilePick || (profiles[0]?.id ?? "");
  const [draft, setDraft] = useState<string>();
  const [asked, setAsked] = useState<number>();

  const reply =
    asked === undefined || busy
      ? undefined
      : items.slice(asked).findLast((item) => item.role === "assistant");

  const written = reply !== undefined && "text" in reply ? reply.text : "";
  const summary = draft ?? written;
  const writing = asked !== undefined && reply === undefined;

  const asking = useAction(async () => {
    setDraft(undefined);
    setAsked(items.length);

    try {
      await command(session.id, { type: "message", text: handoff });
    } catch (failure) {
      setAsked(undefined);
      throw failure;
    }
  });

  const moving = useAction(async () => {
    const moved = await request("sessions.create", {
      body: {
        from: { session: session.id },
        owner: "team",
        summary,
        environment,
        profile,
      },
    });

    onDone();
    navigate(href("session", { id: moved.id }));
  });

  const error = moving.error ?? asking.error;

  const ask = (): void => {
    moving.clear();
    void asking.run();
  };

  const move = (): void => {
    asking.clear();
    void moving.run();
  };

  const ready =
    environments.length > 0 && profiles.length > 0 && summary.trim() !== "";

  return (
    <form
      method="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        move();
      }}
      className="flex flex-col gap-4 p-5"
    >
      <header className="flex items-center gap-2">
        <h2
          id="move-title"
          className="flex-1 text-ui font-semibold text-fg-strong"
        >
          Move to the team
        </h2>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onDone}>
          <Icon name="x" />
        </Button>
      </header>

      <p className="text-label text-fg-dim">
        The team gets a new Session that starts from this summary, on a fresh
        copy of the repository and the team&apos;s logins. This conversation
        stays yours, and anything the summary leaves out stays here.
      </p>

      {environments.length === 0 || profiles.length === 0 ? (
        <Notice role="alert">
          An admin has to set up a team Environment and Profile first.
        </Notice>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Environment">
            <Select
              value={environment}
              onChange={(event) => {
                setEnvironment(event.target.value);
              }}
            >
              {environments.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Profile">
            <Select
              value={profile}
              onChange={(event) => {
                setProfile(event.target.value);
              }}
            >
              {profiles.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      <Field label="Handoff summary">
        <TextArea
          className="min-h-40 resize-y"
          value={summary}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          placeholder="The goal, what is done, what is left"
        />
      </Field>

      <ErrorText>{error}</ErrorText>

      <div className="flex items-center justify-end gap-2">
        <Button className="mr-auto" disabled={writing || busy} onClick={ask}>
          {writing ? "Pi is writing…" : "Ask Pi to write it"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          Move to the team
        </Button>
      </div>
    </form>
  );
}
