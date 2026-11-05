import {
  BadRequest,
  HttpError,
  NotFound,
  readBody,
  type RouteCaller,
  type ServerPlugin,
  type ServerPluginContext,
  Type,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import type { Votes } from "./votes";

const sweepMs = 30_000;
const maxOptions = 8;

const opening = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 500 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 2,
    maxItems: maxOptions,
  }),
  minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 10_080 })),
});

const picking = Type.Object({ option: Type.String() });

interface StoredVote {
  readonly id: string;
  readonly session_id: string;
  readonly opener: string;
  readonly question: string;
  readonly closes_at: number;
}

const schema = `
create table ask_votes (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  opener text not null,
  question text not null,
  opened_at integer not null,
  closes_at integer not null,
  closed_at integer
) strict;
create index ask_votes_session on ask_votes (session_id, opened_at);
create index ask_votes_open on ask_votes (closes_at) where closed_at is null;

create table ask_vote_options (
  vote_id text not null references ask_votes (id) on delete cascade,
  position integer not null,
  label text not null,
  primary key (vote_id, position)
) strict, without rowid;

create table ask_vote_picks (
  vote_id text not null,
  person text not null,
  position integer not null,
  picked_at integer not null,
  primary key (vote_id, person),
  foreign key (vote_id, position) references ask_vote_options (vote_id, position) on delete cascade
) strict;
`;

// Anyone in team work opens a vote, Pi too. The opener or the starter closes
// it, or it closes on time, and Pi reads the result on its next turn
// (ADR 0065).
export const askServer: ServerPlugin = {
  name: "ask",
  schema: schema,
  register: (context) => {
    const votes = ballots(context);

    const sweep = setInterval(votes.sweep, sweepMs);

    context.signal.addEventListener("abort", () => {
      clearInterval(sweep);
    });

    context.tools.register({
      name: "open_vote",
      description:
        "Opens a vote for the team on a choice the team should make together. Everyone following the work picks one option; the vote closes when whoever started the work closes it, or on time. You read the result with the team's messages the next time someone asks you something, so don't wait for it.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The choice, one line" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: maxOptions,
          },
          minutes: {
            type: "number",
            description: "How long it stays open, if not the team's default",
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
      exposure: "direct",
      annotations: { readOnlyHint: false, destructiveHint: false },
      appliesTo: (session) => session.ownedBy === "team",
      run: async (input, { session }) => {
        await Promise.resolve();

        try {
          const vote = votes.open(session, "pi", checked(input));

          return {
            text: `The vote is open until ${vote.closesAt}.`,
            isError: false,
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    });

    context.routes.handle(async (request, path, caller) => {
      if (caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      const [route, id = "", action] = path.split("/");

      if (route === "sessions" && action === "votes") {
        const session = votes.session(id, caller);

        if (request.method === "GET") {
          votes.sweep();

          return Response.json(votes.of(session, caller));
        }

        if (request.method === "POST") {
          const body = await readBody(request, opening);

          return Response.json(votes.open(session, personOf(caller), body), {
            status: 201,
          });
        }
      }

      if (route === "votes" && action === "pick" && request.method === "PUT") {
        const { option } = await readBody(request, picking);
        votes.pick(id, caller, option);

        return Response.json({ ok: true });
      }

      if (
        route === "votes" &&
        action === "close" &&
        request.method === "POST"
      ) {
        votes.close(id, caller);

        return Response.json({ ok: true });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function ballots(context: ServerPluginContext) {
  const { store, sessions } = context;

  const name = (person: string): string =>
    person === "pi"
      ? "Pi"
      : (context.auth.users().find(({ id }) => id === person)?.name ??
        "Someone");

  const stored = (id: string): StoredVote => {
    const [vote] = store.all(
      "select * from ask_votes where id = ? and closed_at is null",
      id,
    ) as StoredVote[];

    if (vote === undefined) {
      throw new NotFound("no open vote with that id");
    }

    return vote;
  };

  const optionsOf = (vote: StoredVote): readonly string[] =>
    (
      store.all(
        "select label from ask_vote_options where vote_id = ? order by position",
        vote.id,
      ) as { label: string }[]
    ).map(({ label }) => label);

  const picksOf = (vote: StoredVote): Readonly<Record<string, string>> =>
    Object.fromEntries(
      (
        store.all(
          "select person, label from ask_vote_picks join ask_vote_options using (vote_id, position) where vote_id = ? order by ask_vote_picks.rowid",
          vote.id,
        ) as { person: string; label: string }[]
      ).map(({ person, label }) => [person, label]),
    );

  const session = (id: string, caller: RouteCaller): Session => {
    const found = sessions.get(id);

    if (
      found === undefined ||
      (!admin(caller) && !sessions.sees(id, personOf(caller)))
    ) {
      throw new NotFound("no session with that id");
    }

    return found;
  };

  const canClose = (
    vote: StoredVote,
    caller: RouteCaller,
    of: Session | undefined,
  ): boolean => {
    const person = personOf(caller);

    return admin(caller) || vote.opener === person || of?.startedBy === person;
  };

  const finish = (vote: StoredVote, by: string | undefined): void => {
    store.run(
      "update ask_votes set closed_at = ? where id = ?",
      Date.now(),
      vote.id,
    );

    const told = sessions.voted(
      vote.session_id,
      vote.opener,
      tally(vote, optionsOf(vote), picksOf(vote), name, by),
    );

    if (!told.ok) {
      context.log("vote result not told", {
        vote: vote.id,
        session: vote.session_id,
        reason: told.reason,
      });
    }

    context.changes.publish("votes");
  };

  return {
    session,
    of: (of: Session, caller: RouteCaller): Votes => {
      const person = personOf(caller);

      const open = store.all(
        "select * from ask_votes where session_id = ? and closed_at is null order by opened_at",
        of.id,
      ) as StoredVote[];

      return {
        canOpen: of.ownedBy === "team" && of.archivedAt === null,
        votes: open.map((vote) => {
          const picks = picksOf(vote);

          return {
            id: vote.id,
            opener: vote.opener,
            question: vote.question,
            options: optionsOf(vote),
            picks: Object.entries(picks).map(([who, option]) => ({
              person: who,
              name: name(who),
              option,
            })),
            mine: picks[person] ?? null,
            canClose: canClose(vote, caller, of),
            closesAt: new Date(vote.closes_at).toISOString(),
          };
        }),
      };
    },
    open: (
      of: Session,
      opener: string,
      { question, options, minutes }: Opening,
    ): { readonly id: string; readonly closesAt: string } => {
      if (of.ownedBy !== "team") {
        throw new HttpError(409, "only team work has votes", "not_team");
      }

      if (of.archivedAt !== null) {
        throw new HttpError(409, "the session is archived", "archived");
      }

      const choices = [...new Set(options.map((option) => option.trim()))];

      if (question.trim() === "" || choices.length < 2) {
        throw new BadRequest("a vote needs a question and two options");
      }

      const now = Date.now();
      const open = minutes ?? Number(context.settings.get()["voteMinutes"]);
      const id = Bun.randomUUIDv7();
      const closesAt = now + open * 60_000;

      store.transaction(() => {
        store.run(
          "insert into ask_votes (id, session_id, opener, question, opened_at, closes_at) values (?, ?, ?, ?, ?, ?)",
          id,
          of.id,
          opener,
          question.trim(),
          now,
          closesAt,
        );

        choices.forEach((label, position) => {
          store.run(
            "insert into ask_vote_options (vote_id, position, label) values (?, ?, ?)",
            id,
            position,
            label,
          );
        });
      });

      context.changes.publish("votes");

      return { id, closesAt: new Date(closesAt).toISOString() };
    },
    pick: (id: string, caller: RouteCaller, option: string): void => {
      const vote = stored(id);
      session(vote.session_id, caller);

      const position = optionsOf(vote).indexOf(option);

      if (position === -1) {
        throw new BadRequest("that is not one of the vote's options");
      }

      store.run(
        "insert into ask_vote_picks (vote_id, person, position, picked_at) values (?, ?, ?, ?) on conflict (vote_id, person) do update set position = excluded.position, picked_at = excluded.picked_at",
        id,
        personOf(caller),
        position,
        Date.now(),
      );

      context.changes.publish("votes");
    },
    close: (id: string, caller: RouteCaller): void => {
      const vote = stored(id);
      const of = session(vote.session_id, caller);

      if (!canClose(vote, caller, of)) {
        throw new HttpError(
          403,
          "only whoever opened the vote or started the work closes it",
          "not_opener",
        );
      }

      finish(vote, personOf(caller));
    },
    sweep: (): void => {
      const due = store.all(
        "select * from ask_votes where closed_at is null and closes_at <= ?",
        Date.now(),
      ) as StoredVote[];

      for (const vote of due) {
        finish(vote, undefined);
      }
    },
  };
}

interface Opening {
  readonly question: string;
  readonly options: readonly string[];
  readonly minutes?: number;
}

function checked(input: unknown): Opening {
  const { question, options, minutes } = (input ?? {}) as Record<
    string,
    unknown
  >;

  if (
    typeof question !== "string" ||
    !Array.isArray(options) ||
    !options.every((option) => typeof option === "string") ||
    options.length > maxOptions ||
    (minutes !== undefined && (typeof minutes !== "number" || minutes < 1))
  ) {
    throw new Error(
      `give a question, 2 to ${String(maxOptions)} options as text, and minutes of at least 1 if any`,
    );
  }

  return {
    question,
    options,
    ...(typeof minutes === "number" && { minutes }),
  };
}

// The result as the team and Pi read it, such as "Ship it today?": Ship 2
// (ana, bo), Wait 0. ana closed it.
function tally(
  vote: StoredVote,
  options: readonly string[],
  picks: Readonly<Record<string, string>>,
  name: (person: string) => string,
  by: string | undefined,
): string {
  const voters = Object.entries(picks);

  const counts = options.map((option) => {
    const people = voters
      .filter(([, picked]) => picked === option)
      .map(([person]) => name(person));

    return people.length === 0
      ? `${option} 0`
      : `${option} ${String(people.length)} (${people.join(", ")})`;
  });

  const closed =
    by === undefined ? "It closed on time." : `${name(by)} closed it.`;

  return voters.length === 0
    ? `"${vote.question}": nobody voted. ${closed}`
    : `"${vote.question}": ${counts.join(", ")}. ${closed}`;
}

function personOf(caller: RouteCaller): string {
  return caller.kind === "user"
    ? caller.actor.slice("user:".length)
    : (caller.session.startedBy ?? "");
}

function admin(caller: RouteCaller): boolean {
  return caller.kind === "user" && caller.admin;
}
