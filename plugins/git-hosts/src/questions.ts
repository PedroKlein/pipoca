import { type Owner, owners, type ServerContext } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";
import type { Acting } from "./acting";
import { hostCall, HostRefused, reach } from "./github";
import type { Hosts } from "./hosts";
import { watchStore } from "./watch";

type Fields = Readonly<Record<string, unknown>>;

// The events about an issue or pull request, which a question goes back to.
const threaded = new Set([
  "git-hosts.issue",
  "git-hosts.comment",
  "git-hosts.pull_request",
  "git-hosts.review",
]);

interface Posted {
  readonly question_id: string;
  readonly comment_url: string;
  readonly people: string;
}

// A question goes back to the issue or pull request its work came from, as
// a comment by the technical user the run acts as, or by the person it acts
// for only if they chose "Reply as me" (ADR 0051, ADR 0076). A later comment
// there by a member of the repository, or by someone the question is for,
// answers it.
export function questionReplies(
  context: Pick<
    ServerContext<typeof gitHosts>,
    "store" | "clock" | "provide" | "questions" | "log" | "network"
  >,
  hosts: Hosts,
  acting: Acting,
  signed: (
    userId: string,
  ) => readonly { readonly host: string; readonly token: string }[],
): (event: { readonly name: string; readonly fields: Fields }) => boolean {
  const { store, clock, questions, log } = context;
  const watches = watchStore(store);

  // Who the comment is posted as, and whether it says it came from Pipoca.
  const poster = (
    session: Parameters<Acting["postsAs"]>[0],
    host: string,
    repository: string,
  ):
    | { readonly token: string; readonly via: boolean; readonly owner: Owner }
    | undefined => {
    const account = repository.split("/")[0] ?? "";
    const bot = acting.postsAs(session, host, account);

    if (bot !== undefined) {
      return { token: bot.token, via: false, owner: "team" };
    }

    const person = owners.personId(session.ownedBy);

    if (
      session.actsAs !== null ||
      person === undefined ||
      !watches.preferences(person).reply
    ) {
      return undefined;
    }

    const own = signed(person).find((each) => each.host === host);

    return own === undefined
      ? undefined
      : { token: own.token, via: true, owner: owners.of(person) };
  };

  context.provide.replies({
    post: async ({ id, session, origin, text, answerers }) => {
      const { fields } = origin;
      const host = hosts.get(String(fields["host"]));
      const repository = String(fields["repository"]);
      const number = Number(fields["number"]);

      if (!threaded.has(origin.event) || host === undefined) {
        return false;
      }

      const as = poster(session, host.host, repository);

      if (as === undefined) {
        return false;
      }

      const response = await reach(
        hostCall(host, context.network, {
          owner: as.owner,
          action: "review reply",
        }),
        `${host.api}/repos/${repository}/issues/${String(number)}/comments`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${as.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            body: `${text}\n\nReply with a comment here to answer.${as.via ? "\n\nvia Pipoca" : ""}`,
          }),
        },
      );

      if (!response.ok) {
        throw new HostRefused(
          `${host.host} answered ${String(response.status)} to a question's comment on ${repository}#${String(number)}`,
        );
      }

      const { html_url: url } = (await response.json().catch(() => ({}))) as {
        html_url?: unknown;
      };

      store.run(
        "insert into git_hosts_questions (question_id, host, repository, number, comment_url, people, posted_at) values (?, ?, ?, ?, ?, ?, ?)",
        id,
        host.host,
        repository,
        number,
        typeof url === "string" ? url : "",
        JSON.stringify(answerers.map((person) => person.id)),
        clock.now(),
      );

      return true;
    },
  });

  const mayAnswer = (row: Posted, host: string, author: string): boolean =>
    (JSON.parse(row.people) as string[]).some(
      (person) =>
        loginOf(store, person, host)?.toLowerCase() === author.toLowerCase(),
    );

  // Whether a comment answered a question, and so isn't an event.
  return ({ name, fields }) => {
    if (name !== "comment") {
      return false;
    }

    const host = String(fields["host"]);
    const author = String(fields["author"]);

    const rows = store.all<Posted>(
      "select question_id, comment_url, people from git_hosts_questions where host = ? and repository = ? and number = ? order by posted_at",
      host,
      String(fields["repository"]),
      Number(fields["number"]),
    );

    for (const row of rows) {
      if (row.comment_url === fields["url"]) {
        return false;
      }

      if (fields["member"] !== true && !mayAnswer(row, host, author)) {
        continue;
      }

      store.run(
        "delete from git_hosts_questions where question_id = ?",
        row.question_id,
      );

      if (
        questions.answer(row.question_id, {
          text: String(fields["body"]),
          by: author,
        })
      ) {
        log("question answered on the host", { id: row.question_id, host });

        return true;
      }
    }

    return false;
  };
}

function loginOf(
  store: ServerContext["store"],
  person: string,
  host: string,
): string | undefined {
  return store.get<{ login: string }>(
    "select login from git_hosts_connections where user_id = ? and host = ?",
    person,
    host,
  )?.login;
}
