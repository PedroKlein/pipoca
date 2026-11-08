import {
  BadRequest,
  defineServer,
  HttpError,
  NotFound,
  type Person,
  type ServerContext,
  type Session,
  Type,
} from "@pipoca/plugins";
import { ask } from "../plugin";
import { waitingQuestions } from "./questions";
import type { Votes } from "./votes";

const opening = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "The choice, one line",
  }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 2,
    maxItems: 8,
  }),
  minutes: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 10_080,
      description: "How long it stays open, if not the team's default",
    }),
  ),
});

const picking = Type.Object({ option: Type.String() });

// A person opens a vote as user:<id>, and Pi as the Session it runs in.
type Opener = `user:${string}` | `session:${string}`;

interface StoredVote {
  readonly id: string;
  readonly session_id: string;
  readonly opener: Opener;
  readonly question: string;
  readonly closes_at: number;
}

// Anyone in team work opens a vote, Pi too. The opener or the starter closes
// it, or it closes on time, and Pi reads the result on its next turn
// (ADR 0065).
export const server = defineServer(ask, (context) => {
  const { routes, schedule, tools } = context;
  const votes = ballots(context);
  waitingQuestions(context);

  schedule.on("close:", (id) => {
    votes.closeOnTime(String(id));
  });

  tools.define({
    name: "open_vote",
    description:
      "Opens a vote for the team on a choice the team should make together. Everyone following the work picks one option; the vote closes when whoever started the work closes it, or on time. You read the result with the team's messages the next time someone asks you something, so don't wait for it.",
    params: opening,
    when: { owner: "team" },
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    run: (input, { session }) => {
      const vote = votes.open(session, `session:${session.id}`, input);
      routes.topic("votes");

      return `The vote is open until ${vote.closesAt}.`;
    },
  });

  routes.get(
    "sessions/:id/votes",
    { auth: "person" },
    ({ params, caller: { person } }) =>
      votes.of(votes.session(params.id, person), person),
  );

  routes.post(
    "sessions/:id/votes",
    { auth: "person", body: opening, status: 201, changes: ["votes"] },
    ({ params, caller: { person }, body }) =>
      votes.open(votes.steered(params.id, person), `user:${person.id}`, body),
  );

  routes.put(
    "votes/:id/pick",
    { auth: "person", body: picking, changes: ["votes"] },
    ({ params, caller, body }) => {
      votes.pick(params.id, caller.person, body.option);

      return { ok: true };
    },
  );

  routes.post(
    "votes/:id/close",
    { auth: "person", changes: ["votes"] },
    ({ params, caller }) => {
      votes.close(params.id, caller.person);

      return { ok: true };
    },
  );
});

function ballots(context: ServerContext<typeof ask>) {
  const { store, sessions, people, schedule, clock, config, routes } = context;

  const name = (person: string): string =>
    people.get(person)?.name ?? "Someone";

  const stored = (id: string): StoredVote | undefined =>
    store.get<StoredVote>(
      "select * from ask_votes where id = ? and closed_at is null",
      id,
    );

  const open = (id: string): StoredVote => {
    const vote = stored(id);

    if (vote === undefined) {
      throw new NotFound("no open vote with that id");
    }

    return vote;
  };

  const optionsOf = (vote: StoredVote): readonly string[] =>
    store
      .all<{ label: string }>(
        "select label from ask_vote_options where vote_id = ? order by position",
        vote.id,
      )
      .map(({ label }) => label);

  const picksOf = (vote: StoredVote): Readonly<Record<string, string>> =>
    Object.fromEntries(
      store
        .all<{ user_id: string; label: string }>(
          "select user_id, label from ask_vote_picks join ask_vote_options using (vote_id, position) where vote_id = ? order by ask_vote_picks.rowid",
          vote.id,
        )
        .map(({ user_id, label }) => [user_id, label]),
    );

  const session = (id: string, person: Person): Session => {
    const found = sessions.get(id);

    if (
      found === undefined ||
      (!person.admin && !sessions.sees(id, person.id))
    ) {
      throw new NotFound("no session with that id");
    }

    return found;
  };

  const steered = (id: string, person: Person): Session => {
    const found = session(id, person);

    if (!sessions.steers(id, person.id)) {
      throw new HttpError(
        403,
        "only people who steer the work open or close its votes",
        "view_only",
      );
    }

    return found;
  };

  const canClose = (vote: StoredVote, person: Person, of: Session): boolean =>
    sessions.steers(of.id, person.id) &&
    (person.admin ||
      vote.opener === `user:${person.id}` ||
      of.startedBy === person.id);

  const finish = (vote: StoredVote, by: string | undefined): void => {
    store.run(
      "update ask_votes set closed_at = ? where id = ?",
      clock.now(),
      vote.id,
    );

    const told = sessions.send(vote.session_id, {
      text: `Vote closed. ${tally(vote, optionsOf(vote), picksOf(vote), name, by)}`,
      turn: false,
      notice: { kind: "vote_result" },
    });

    if (told === "gone") {
      context.log("vote result not told", {
        vote: vote.id,
        session: vote.session_id,
      });
    }
  };

  return {
    session,
    steered,
    of: (of: Session, person: Person): Votes => {
      const opened = store.all<StoredVote>(
        "select * from ask_votes where session_id = ? and closed_at is null order by opened_at",
        of.id,
      );

      return {
        canOpen:
          of.ownedBy === "team" &&
          of.archivedAt === null &&
          sessions.steers(of.id, person.id),
        votes: opened.map((vote) => {
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
            mine: picks[person.id] ?? null,
            canClose: canClose(vote, person, of),
            closesAt: new Date(vote.closes_at).toISOString(),
          };
        }),
      };
    },
    open: (
      of: Session,
      opener: Opener,
      {
        question,
        options,
        minutes = config.get().voteMinutes,
      }: {
        readonly question: string;
        readonly options: readonly string[];
        readonly minutes?: number;
      },
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

      const now = clock.now();
      const id = Bun.randomUUIDv7();
      const closesAt = now + minutes * 60_000;

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

      schedule.at(`close:${id}`, closesAt, id);

      return { id, closesAt: new Date(closesAt).toISOString() };
    },
    pick: (id: string, person: Person, option: string): void => {
      const vote = open(id);
      session(vote.session_id, person);

      const position = optionsOf(vote).indexOf(option);

      if (position === -1) {
        throw new BadRequest("that is not one of the vote's options");
      }

      store.run(
        "insert into ask_vote_picks (vote_id, user_id, position, picked_at) values (?, ?, ?, ?) on conflict (vote_id, user_id) do update set position = excluded.position, picked_at = excluded.picked_at",
        id,
        person.id,
        position,
        clock.now(),
      );
    },
    close: (id: string, person: Person): void => {
      const vote = open(id);

      if (!canClose(vote, person, steered(vote.session_id, person))) {
        throw new HttpError(
          403,
          "only whoever opened the vote or started the work closes it",
          "not_opener",
        );
      }

      schedule.cancel(`close:${vote.id}`);
      finish(vote, person.id);
    },
    closeOnTime: (id: string): void => {
      const vote = stored(id);

      if (vote !== undefined) {
        finish(vote, undefined);
        routes.topic("votes");
      }
    },
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
    const voted = voters
      .filter(([, picked]) => picked === option)
      .map(([person]) => name(person));

    return voted.length === 0
      ? `${option} 0`
      : `${option} ${String(voted.length)} (${voted.join(", ")})`;
  });

  const closed =
    by === undefined ? "It closed on time." : `${name(by)} closed it.`;

  return voters.length === 0
    ? `"${vote.question}": nobody voted. ${closed}`
    : `"${vote.question}": ${counts.join(", ")}. ${closed}`;
}
