import {
  defineWeb,
  type MountedSession,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import {
  Button,
  cn,
  Dialog,
  ErrorText,
  Field,
  fieldClass,
  Icon,
  ListInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { ask } from "../plugin";
import type { Vote, Votes } from "../src/votes";

interface Props {
  readonly session: MountedSession;
}

// Open votes sit above the composer of team work, and anyone following it
// opens one from the header (ADR 0065).
export default defineWeb(ask, {
  settings: { group: "server", form: "auto" },
  slots: { "session.composer": OpenVotes, "session.header": VoteButton },
});

function useVotes({ session }: Props): Votes | undefined {
  const api = useApi(ask);

  return useLoaded(
    async () =>
      api.get<Votes>(`sessions/${encodeURIComponent(session.id)}/votes`),
    session.id,
    { topics: ["ask.votes"] },
  ).value;
}

function OpenVotes(props: Props): ReactElement | null {
  const votes = useVotes(props);

  if (votes === undefined || votes.votes.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {votes.votes.map((vote) => (
        <VoteCard key={vote.id} vote={vote} />
      ))}
    </div>
  );
}

function VoteCard({ vote }: { readonly vote: Vote }): ReactElement {
  const api = useApi(ask);
  const [error, setError] = useState<string>();

  const act = (sent: Promise<unknown>): void => {
    setError(undefined);

    sent.catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const voted = vote.picks.length;

  const closes = new Date(vote.closesAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <section
      aria-label={`Vote: ${vote.question}`}
      className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2"
    >
      <header className="flex min-w-0 items-center gap-2 text-label">
        <span className="min-w-0 flex-1 break-words font-medium text-fg">
          {vote.question}
        </span>
        <span className="shrink-0 text-fg-dim">
          {String(voted)} voted, closes {closes}
        </span>
        {vote.canClose && (
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              act(api.post(`votes/${vote.id}/close`));
            }}
          >
            Close vote
          </Button>
        )}
      </header>
      <ul className="flex flex-col gap-1">
        {vote.options.map((option) => {
          const people = vote.picks
            .filter((pick) => pick.option === option)
            .map(({ name }) => name);

          return (
            <li key={option}>
              <button
                type="button"
                aria-pressed={vote.mine === option}
                onClick={() => {
                  act(api.put(`votes/${vote.id}/pick`, { option }));
                }}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-label",
                  vote.mine === option
                    ? "border-accent bg-hover text-fg-strong"
                    : "border-line text-fg hover:bg-hover",
                )}
              >
                {vote.mine === option && (
                  <Icon name="check" className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 break-words">{option}</span>
                <span className="shrink-0 text-fg-dim">
                  {people.length === 0 ? "" : people.join(", ")}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {String(people.length)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

function VoteButton(props: Props): ReactElement | null {
  const votes = useVotes(props);
  const [open, setOpen] = useState(false);

  if (votes?.canOpen !== true) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="users" />
        Vote
      </Button>
      <OpenVoteDialog
        {...props}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

function OpenVoteDialog({
  session,
  open,
  onClose,
}: Props & {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="vote-title" size="sm">
      <VoteForm session={session} onDone={onClose} />
    </Dialog>
  );
}

function VoteForm({
  session,
  onDone,
}: Props & { readonly onDone: () => void }): ReactElement {
  const api = useApi(ask);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<readonly string[]>([]);
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string>();

  const submit = (): void => {
    api
      .post(`sessions/${encodeURIComponent(session.id)}/votes`, {
        question,
        options,
        ...(minutes.trim() !== "" && { minutes: Number(minutes) }),
      })
      .then(onDone)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  };

  return (
    <form
      method="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4 p-5"
    >
      <header className="flex items-center gap-2">
        <h2
          id="vote-title"
          className="flex-1 text-ui font-semibold text-fg-strong"
        >
          Open a vote
        </h2>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onDone}>
          <Icon name="x" />
        </Button>
      </header>

      <Field label="Question">
        <input
          className={fieldClass}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          placeholder="Ship it today?"
        />
      </Field>

      <ListInput
        label="Options"
        values={options}
        placeholder="Type an option and press Enter"
        onChange={setOptions}
      />

      <Field
        label="Minutes open"
        hint="Leave empty for the team's default. You or whoever started the work can close it sooner."
      >
        <input
          className={fieldClass}
          inputMode="numeric"
          value={minutes}
          onChange={(event) => {
            setMinutes(event.target.value);
          }}
        />
      </Field>

      <p className="text-label text-fg-dim">
        Everyone following this work can vote. Pi reads the result the next time
        someone asks it something.
      </p>

      <ErrorText>{error}</ErrorText>

      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={question.trim() === "" || options.length < 2}
        >
          Open vote
        </Button>
      </div>
    </form>
  );
}
