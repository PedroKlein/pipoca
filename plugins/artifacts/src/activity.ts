import type { Store } from "@pipoca/plugins";
import type { Clock } from "@pipoca/protocol";
import {
  type ActivityItem,
  type ActivityKind,
  type ActivitySettings,
  type ActivityTopic,
  activityTopics,
  type DocType,
  headline,
  topicOf,
} from "./artifacts";

const shownItems = 50;
const excerptLength = 140;

// A topic a person never set is told, except every comment on their own
// artifacts, which they ask for.
const defaults: ActivitySettings = {
  asked: true,
  replies: true,
  comments: false,
};

interface ItemRow {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly artifact_id: string;
  readonly title: string;
  readonly comment_id: string | null;
  readonly thread_id: string | null;
  readonly quote: string | null;
  readonly body: string | null;
  readonly actor_user_id: string | null;
  readonly by_pi: number;
  readonly suggested: number;
  readonly version: number;
  readonly created_at: number;
  readonly read_at: number | null;
}

interface Told {
  readonly kind: Exclude<ActivityKind, "comment">;
  readonly artifact: string;
  readonly thread: string | null;
  readonly headline: string;
  readonly text: string;
}

// What each person is told of on artifacts they see: mentions, review
// requests, replies in threads they're in and, when they ask, comments on
// their own artifacts (ADR 0081).
export function activityLog({
  store,
  clock,
  name,
  sees,
  docType,
  told,
}: {
  readonly store: Store;
  readonly clock: Clock;
  readonly name: (person: string | null, reader: string) => string;
  readonly sees: (artifact: string, person: string) => boolean;
  readonly docType: (
    artifact: string,
    person: string,
  ) => Promise<DocType | null>;
  // Mentions, review requests and replies, as they're told elsewhere too.
  readonly told: (person: string, what: Told) => void;
}): {
  readonly tell: (
    artifact: string,
    to: ReadonlyMap<string, ActivityKind>,
    what: {
      readonly comment: string | null;
      readonly actor: string;
      readonly byPi?: boolean;
    },
  ) => void;
  readonly list: (
    person: string,
    view: "mine" | "following",
  ) => Promise<{ readonly items: ActivityItem[]; readonly unread: number }>;
  readonly unread: (person: string) => number;
  readonly read: (person: string, ids: readonly string[] | undefined) => void;
  readonly settings: (person: string) => ActivitySettings;
  readonly set: (person: string, topic: ActivityTopic, on: boolean) => void;
} {
  const settings = (person: string): ActivitySettings => {
    const set = new Map(
      store
        .all<{ topic: ActivityTopic; told: number }>(
          "select topic, told from artifacts_activity_settings where user_id = ?",
          person,
        )
        .map(({ topic, told: on }) => [topic, on === 1]),
    );

    return Object.fromEntries(
      activityTopics.map((topic) => [topic, set.get(topic) ?? defaults[topic]]),
    ) as ActivitySettings;
  };

  const unread = (person: string): number =>
    store
      .all<{ artifact_id: string }>(
        "select artifact_id from artifacts_activity where user_id = ? and read_at is null",
        person,
      )
      .filter(({ artifact_id }) => sees(artifact_id, person)).length;

  const select = `select a.id, a.kind, a.artifact_id, t.title, a.comment_id,
      coalesce(c.parent_id, c.id) as thread_id, top.quote, c.body,
      a.actor_user_id, a.by_pi,
      exists (select 1 from artifacts_suggestions s where s.comment_id = c.id) as suggested,
      (select max(number) from artifacts_versions v where v.artifact_id = a.artifact_id) as version,
      a.created_at, a.read_at
    from artifacts_activity a
    join artifacts_artifacts t on t.id = a.artifact_id
    left join artifacts_comments c on c.id = a.comment_id
    left join artifacts_comments top on top.id = coalesce(c.parent_id, c.id)`;

  const item = async (each: ItemRow, person: string): Promise<ActivityItem> => {
    const byPi = each.by_pi === 1;

    return {
      id: each.id,
      kind: each.kind,
      artifact: each.artifact_id,
      title: each.title,
      thread: each.thread_id,
      quote: each.quote ?? "",
      by: byPi ? "Pi" : name(each.actor_user_id, person),
      byPi,
      suggested: each.suggested === 1,
      excerpt: excerpt(each.body ?? ""),
      doc:
        each.kind === "review" ? await docType(each.artifact_id, person) : null,
      version: each.version,
      at: each.created_at,
      read: each.read_at !== null,
    };
  };

  // The comments others wrote on artifacts the person owns, wrote in or
  // reviews, newest first.
  const following = (person: string): ItemRow[] =>
    store.all<ItemRow>(
      `select c.id, case when c.parent_id is null then 'comment' else 'reply' end as kind,
         c.artifact_id, t.title, c.id as comment_id,
         coalesce(c.parent_id, c.id) as thread_id, top.quote, c.body,
         c.author_user_id as actor_user_id, c.by_pi,
         exists (select 1 from artifacts_suggestions s where s.comment_id = c.id) as suggested,
         (select max(number) from artifacts_versions v where v.artifact_id = c.artifact_id) as version,
         c.created_at, c.created_at as read_at
       from artifacts_comments c
       join artifacts_artifacts t on t.id = c.artifact_id
       join artifacts_comments top on top.id = coalesce(c.parent_id, c.id)
       where (c.by_pi = 1 or c.author_user_id is not ?)
         and (t.owner_user_id = ?
           or exists (select 1 from artifacts_comments mine where mine.artifact_id = c.artifact_id and mine.author_user_id = ? and mine.by_pi = 0)
           or exists (select 1 from artifacts_reviewers r where r.artifact_id = c.artifact_id and r.user_id = ?))
       order by c.created_at desc, c.id desc limit ${String(shownItems * 4)}`,
      person,
      person,
      person,
      person,
    );

  return {
    tell: (artifact, to, { comment, actor, byPi = false }) => {
      const now = clock.now();

      for (const [person, kind] of to) {
        if (
          (person === actor && !byPi) ||
          !sees(artifact, person) ||
          !settings(person)[topicOf[kind]]
        ) {
          continue;
        }

        const id = Bun.randomUUIDv7();

        store.run(
          "insert into artifacts_activity (id, user_id, kind, artifact_id, comment_id, actor_user_id, by_pi, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          person,
          kind,
          artifact,
          comment,
          actor,
          byPi ? 1 : 0,
          now,
        );

        const row = store.get<ItemRow>(`${select} where a.id = ?`, id);

        if (row === undefined || kind === "comment") {
          continue;
        }

        told(person, {
          kind,
          artifact,
          thread: row.thread_id,
          headline: headline({
            kind,
            by: byPi ? "Pi" : name(actor, person),
            byPi,
            suggested: row.suggested === 1,
            title: row.title,
          }),
          text: excerpt(row.body ?? ""),
        });
      }
    },
    list: async (person, view) => {
      const rows =
        view === "mine"
          ? store.all<ItemRow>(
              `${select} where a.user_id = ? order by a.created_at desc, a.id desc limit ${String(shownItems * 4)}`,
              person,
            )
          : following(person);

      const seen = rows
        .filter((each) => sees(each.artifact_id, person))
        .slice(0, shownItems);

      return {
        items: await Promise.all(seen.map(async (each) => item(each, person))),
        unread: view === "mine" ? unread(person) : 0,
      };
    },
    unread,
    read: (person, ids) => {
      const now = clock.now();

      if (ids === undefined) {
        store.run(
          "update artifacts_activity set read_at = ? where user_id = ? and read_at is null",
          now,
          person,
        );

        return;
      }

      store.transaction(() => {
        for (const id of ids) {
          store.run(
            "update artifacts_activity set read_at = ? where id = ? and user_id = ? and read_at is null",
            now,
            id,
            person,
          );
        }
      });
    },
    settings,
    set: (person, topic, on) => {
      store.run(
        "insert into artifacts_activity_settings (user_id, topic, told) values (?, ?, ?) on conflict (user_id, topic) do update set told = excluded.told",
        person,
        topic,
        on ? 1 : 0,
      );
    },
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > excerptLength
    ? `${flat.slice(0, excerptLength - 1)}…`
    : flat;
}
