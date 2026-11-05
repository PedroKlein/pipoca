import type { Session } from "@pipoca/protocol";
import {
  Button,
  Dialog,
  ErrorText,
  Field,
  fieldClass,
  Icon,
  Select,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api, command } from "./api";
import type { FeedItem } from "./feed";
import { useTeamEnvironments, useTeamProfiles } from "./hooks";

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
  const environments = useTeamEnvironments().value;
  const profiles = useTeamProfiles().value;
  const [environmentPick, setEnvironment] = useState("");
  const [profilePick, setProfile] = useState("");
  const environment = environmentPick || (environments[0]?.id ?? "");
  const profile = profilePick || (profiles[0]?.id ?? "");
  const [draft, setDraft] = useState<string>();
  const [asked, setAsked] = useState<number>();
  const [error, setError] = useState<string>();

  const reply =
    asked === undefined || busy
      ? undefined
      : items.slice(asked).findLast((item) => item.role === "assistant");

  const written = reply !== undefined && "text" in reply ? reply.text : "";
  const summary = draft ?? written;
  const writing = asked !== undefined && reply === undefined;

  const ask = (): void => {
    setError(undefined);
    setDraft(undefined);
    setAsked(items.length);

    command(session.id, { type: "message", text: handoff }).catch(
      (failure: unknown) => {
        setAsked(undefined);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  const move = (): void => {
    setError(undefined);

    api(`/api/sessions/${encodeURIComponent(session.id)}/move`, {
      summary,
      environment,
      profile,
    })
      .then(async (response) => {
        const moved = (await response.json()) as Session;
        onDone();
        location.hash = moved.id;
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
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
        <p role="alert" className="text-label text-fg-dim">
          An admin has to set up a team Environment and Profile first.
        </p>
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
        <textarea
          className={`${fieldClass} min-h-40 resize-y`}
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
