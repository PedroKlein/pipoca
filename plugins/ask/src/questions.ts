import {
  HttpError,
  NotFound,
  type OpenQuestion,
  type Origin,
  type Person,
  type Reply,
  type ServerContext,
  type Session,
  Type,
} from "@pipoca/plugins";
import { type Question, question } from "@pipoca/protocol";
import type { ask } from "../plugin";
import {
  type Asked,
  type Defaults,
  questionText,
  timedOut,
  type WaitingQuestions,
} from "./waiting";

// A question waits a day for its answer unless it or its Session says
// otherwise (ADR 0076).
const defaultTimeoutMs = 24 * 3_600_000;

const expire = "expire:";

const asking = Type.Object({
  questions: Type.Array(question, { minItems: 1 }),
  defaults: Type.Record(Type.String(), Type.String()),
  for: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
});

const answering = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 10_000 }),
});

interface WaitRow {
  readonly origin: string | null;
  readonly owner_user_id: string | null;
  readonly people: string;
  readonly timeout_ms: number | null;
}

interface QuestionRow {
  readonly id: string;
  readonly session_id: string;
  readonly questions: string;
  readonly defaults: string;
  readonly people: string;
  readonly closes_at: number;
}

const questionsOf = (row: QuestionRow): Question[] =>
  JSON.parse(row.questions) as Question[];

const defaultsOf = (row: QuestionRow): Defaults =>
  JSON.parse(row.defaults) as Defaults;

const idsOf = (text: string): string[] => JSON.parse(text) as string[];

// Questions in Sessions another plugin started, such as a routine's run,
// end the turn and wait past it: in Pipoca's Needs you, where the work came
// from, and until they time out (ADR 0076).
export function waitingQuestions(context: ServerContext<typeof ask>): void {
  const { store, sessions, people, schedule, clock, routes, log } = context;

  const waitOf = (sessionId: string): WaitRow | undefined =>
    store.get<WaitRow>(
      "select origin, owner_user_id, people, timeout_ms from ask_waits where session_id = ?",
      sessionId,
    );

  const openRow = (id: string): QuestionRow | undefined =>
    store.get<QuestionRow>(
      "select * from ask_questions where id = ? and closed_at is null",
      id,
    );

  const openIn = (sessionId: string): readonly QuestionRow[] =>
    store.all<QuestionRow>(
      "select * from ask_questions where session_id = ? and closed_at is null order by asked_at",
      sessionId,
    );

  const answerers = (row: QuestionRow): readonly Person[] => {
    const owner = waitOf(row.session_id)?.owner_user_id ?? null;

    return [...new Set([owner, ...idsOf(row.people)])].flatMap((id) => {
      const found = id === null ? undefined : people.get(id);

      return found === undefined ? [] : [found];
    });
  };

  // Needs you names the person a question is for, in team work.
  const need = (row: QuestionRow): void => {
    const [first] = answerers(row);

    try {
      sessions.need(
        row.session_id,
        row.id,
        first === undefined ? {} : { for: first.name },
      );
    } catch (error) {
      log("question not shown", { id: row.id, error: String(error) });
    }
  };

  const close = (row: QuestionRow, by: string | null): boolean => {
    const closed =
      store.run(
        "update ask_questions set closed_at = ?, answered_by = ? where id = ? and closed_at is null",
        clock.now(),
        by,
        row.id,
      ).changes === 1;

    if (closed) {
      schedule.cancel(`${expire}${row.id}`);

      try {
        sessions.need(row.session_id, row.id, null);
      } catch {
        // The Session is gone, and its need with it.
      }

      routes.topic("questions");
    }

    return closed;
  };

  const tell = (row: QuestionRow, text: string): void => {
    const told = sessions.send(row.session_id, {
      text,
      turn: true,
      notice: { kind: "question_answered", data: { id: row.id } },
      dedupe: `question:${row.id}`,
    });

    if (told === "gone") {
      log("question's answer not told", {
        id: row.id,
        session: row.session_id,
      });
    }
  };

  const answer = (id: string, reply: Reply): boolean => {
    const row = openRow(id);

    if (row === undefined || !close(row, reply.by)) {
      return false;
    }

    tell(
      row,
      `The answer to question ${row.id}, from ${reply.by}:\n\n${reply.text.trim()}`,
    );

    log("question answered", { id, session: row.session_id });

    return true;
  };

  const desk = context.provide.questions({
    wait: (sessionId, waiting) => {
      store.run(
        "insert into ask_waits (session_id, origin, owner_user_id, people, timeout_ms) values (?, ?, ?, ?, ?) on conflict (session_id) do update set origin = excluded.origin, owner_user_id = excluded.owner_user_id, people = excluded.people, timeout_ms = excluded.timeout_ms",
        sessionId,
        waiting.origin === undefined ? null : JSON.stringify(waiting.origin),
        waiting.owner ?? null,
        JSON.stringify(waiting.for ?? []),
        waiting.timeoutMs ?? null,
      );
    },
    answer,
    open: (sessionId): readonly OpenQuestion[] =>
      openIn(sessionId).map((row) => ({
        id: row.id,
        questions: questionsOf(row),
        closesAt: new Date(row.closes_at).toISOString(),
      })),
  });

  const post = (row: QuestionRow, session: Session, origin: Origin): void => {
    const questions = questionsOf(row);
    const closesAt = new Date(row.closes_at).toISOString();

    desk
      .post({
        id: row.id,
        session,
        origin,
        questions,
        text: questionText(questions, defaultsOf(row), closesAt),
        closesAt,
        answerers: answerers(row),
      })
      .then(
        (posted) => {
          log(posted ? "question posted" : "question stays in Pipoca", {
            id: row.id,
            event: origin.event,
          });
        },
        (error: unknown) => {
          log("question not posted", { id: row.id, error: String(error) });
        },
      );
  };

  // The Session asks: past its turn when another plugin said so, or else in
  // the Session as always.
  routes.post(
    "questions",
    { auth: "session", body: asking, changes: ["questions"] },
    ({ caller: { session }, body }): Asked => {
      const waiting = waitOf(session.id);

      if (waiting === undefined) {
        return { wait: "here" };
      }

      const now = clock.now();
      const id = Bun.randomUUIDv7();

      const named =
        body.for === undefined ? undefined : people.byName(body.for)?.id;

      const forIds = [
        ...new Set([
          ...idsOf(waiting.people),
          ...(named === undefined ? [] : [named]),
        ]),
      ];

      const closesAt =
        now + (body.timeoutMs ?? waiting.timeout_ms ?? defaultTimeoutMs);

      store.run(
        "insert into ask_questions (id, session_id, questions, defaults, people, asked_at, closes_at) values (?, ?, ?, ?, ?, ?, ?)",
        id,
        session.id,
        JSON.stringify(body.questions),
        JSON.stringify(body.defaults),
        JSON.stringify(forIds),
        now,
        closesAt,
      );

      schedule.at(`${expire}${id}`, closesAt, id);

      const row = openRow(id);

      if (row !== undefined) {
        need(row);

        if (waiting.origin !== null) {
          post(row, session, JSON.parse(waiting.origin) as Origin);
        }
      }

      log("question waits", { id, session: session.id });

      return {
        wait: "message",
        id,
        closesAt: new Date(closesAt).toISOString(),
      };
    },
  );

  schedule.on(expire, (payload) => {
    const row = openRow(String(payload));

    if (row === undefined || !close(row, null)) {
      return;
    }

    const questions = questionsOf(row);

    tell(
      row,
      `Question ${row.id} timed out. ${timedOut(questions, defaultsOf(row))}`,
    );

    log("question timed out", { id: row.id, session: row.session_id });
  });

  context.events.on("SessionArchived", ({ session }) => {
    for (const row of openIn(session.id)) {
      close(row, null);
    }
  });

  const seen = (id: string, person: Person): Session => {
    const found = sessions.get(id);

    if (
      found === undefined ||
      (!person.admin && !sessions.sees(id, person.id))
    ) {
      throw new NotFound("no session with that id");
    }

    return found;
  };

  const mayAnswer = (row: QuestionRow, person: Person): boolean =>
    sessions.steers(row.session_id, person.id) ||
    answerers(row).some(({ id }) => id === person.id);

  routes.get(
    "sessions/:id/questions",
    { auth: "person" },
    ({ params, caller: { person } }): WaitingQuestions => ({
      questions: openIn(seen(params.id, person).id).map((row) => ({
        id: row.id,
        questions: questionsOf(row),
        closesAt: new Date(row.closes_at).toISOString(),
        mayAnswer: mayAnswer(row, person),
      })),
    }),
  );

  routes.post(
    "questions/:id/answer",
    { auth: "person", body: answering, changes: ["questions"] },
    ({ params, caller: { person }, body }) => {
      const row = openRow(params.id);

      if (row === undefined) {
        throw new NotFound("no open question with that id");
      }

      if (!mayAnswer(row, person)) {
        throw new HttpError(
          403,
          "only the people the question is for, or who steer the work, answer it",
          "not_asked",
        );
      }

      answer(row.id, { text: body.text, by: person.name });

      return { ok: true };
    },
  );

  // Needs you lives in memory, so it comes back for the questions still
  // open when the server starts.
  for (const row of store.all<QuestionRow>(
    "select * from ask_questions where closed_at is null",
  )) {
    need(row);
  }
}
