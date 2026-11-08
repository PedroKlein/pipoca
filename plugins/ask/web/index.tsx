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
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Icon,
  ListInput,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { ask } from "../plugin";
import type { Vote, Votes } from "../src/votes";
import type { WaitingQuestion, WaitingQuestions } from "../src/waiting";

interface Props {
  readonly session: MountedSession;
}

// Questions that wait past their turn and open votes sit above the
// composer, and anyone following team work opens a vote from the header
// (ADR 0065, ADR 0076).
export const web = defineWeb(ask, {
  settings: { group: "server", form: "auto" },
  slots: { "session.composer": AboveComposer, "session.header": VoteButton },
});

function AboveComposer(props: Props): ReactElement {
  return (
    <>
      <OpenQuestions {...props} />
      <OpenVotes {...props} />
    </>
  );
}

function OpenQuestions({ session }: Props): ReactElement | null {
  const api = useApi(ask);

  const waiting = useLoaded(
    async () =>
      api.get<WaitingQuestions>(
        `sessions/${encodeURIComponent(session.id)}/questions`,
      ),
    session.id,
    { changes: ["questions"] },
  ).value;

  if (waiting === undefined || waiting.questions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {waiting.questions.map((each) => (
        <QuestionCard key={each.id} asked={each} />
      ))}
    </div>
  );
}

function QuestionCard({
  asked,
}: {
  readonly asked: WaitingQuestion;
}): ReactElement {
  const api = useApi(ask);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  const send = (answer: string): void => {
    setError(undefined);

    api
      .post(`questions/${asked.id}/answer`, { text: answer })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  };

  const [only] = asked.questions;

  const choices =
    asked.questions.length === 1 && only?.type === "single" ? only.options : [];

  const closes = new Date(asked.closesAt).toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <section
      aria-label="Pi is waiting for an answer"
      className="flex flex-col gap-2 rounded-lg border border-line border-t-3 border-t-waiting bg-panel px-3 py-2"
    >
      <header className="flex min-w-0 items-center gap-2 text-label">
        <span className="min-w-0 flex-1 font-medium text-waiting">
          Pi is waiting for an answer
        </span>
        <span className="shrink-0 text-fg-dim">until {closes}</span>
      </header>
      {asked.questions.map((question) => (
        <div key={question.id} className="flex flex-col gap-0.5 text-label">
          <span className="break-words text-fg">{question.prompt}</span>
          {question.context !== null && (
            <span className="break-words text-fg-dim">{question.context}</span>
          )}
          {"options" in question && question.type !== "single" && (
            <span className="break-words text-fg-dim">
              {question.options.map(({ label }) => label).join(", ")}
            </span>
          )}
        </div>
      ))}
      {asked.mayAnswer && (
        <>
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {choices.map((option) => (
                <Button
                  key={option.value}
                  onClick={() => {
                    send(option.label);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              send(text);
            }}
          >
            <TextInput
              className="min-w-0 flex-1"
              aria-label="Your answer"
              placeholder="Answer in your own words"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={text.trim() === ""}
            >
              Answer
            </Button>
          </form>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

function useVotes({ session }: Props): Votes | undefined {
  const api = useApi(ask);

  return useLoaded(
    async () =>
      api.get<Votes>(`sessions/${encodeURIComponent(session.id)}/votes`),
    session.id,
    { changes: ["votes"] },
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
    <Dialog open={open} onClose={onClose} title="Open a vote" size="sm">
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
    >
      <DialogBody>
        <Field label="Question">
          <TextInput
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
          <TextInput
            inputMode="numeric"
            value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value);
            }}
          />
        </Field>

        <p className="text-label text-fg-dim">
          Everyone following this work can vote. Pi reads the result the next
          time someone asks it something.
        </p>

        <ErrorText>{error}</ErrorText>
      </DialogBody>

      <DialogFoot>
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={question.trim() === "" || options.length < 2}
        >
          Open vote
        </Button>
      </DialogFoot>
    </form>
  );
}
