import type { Static } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";

type Defined = (typeof gitHosts)["events"];

// One of the plugin's events, by its name and fields.
type HostEvent = {
  [N in keyof Defined]: {
    readonly name: N;
    readonly fields: Static<Defined[N]["fields"]>;
  };
}[keyof Defined];

// An event and what makes it the same one when the host tells it twice,
// such as by webhook and by poll.
type Heard = HostEvent & { readonly key: string };

type Fields = Readonly<Record<string, unknown>>;

// The longest body text an event carries. Routines put events in a prompt.
const maxBody = 4000;

// A GitHub webhook as one of the plugin's events, or undefined for those it
// doesn't pass on. Every event says which repository it is about and whether
// whoever caused it is a member of it, since anyone who can reach a public
// repository can open an issue or comment (ADR 0061). The poller builds the
// same payloads from the REST API, so both give the same key.
export function eventOf(
  host: string,
  technicalUser: string,
  kind: string,
  payload: unknown,
): Heard | undefined {
  if (!isObject(payload) || !isObject(payload["repository"])) {
    return undefined;
  }

  const repository = text(payload["repository"]["full_name"]);
  const action = text(payload["action"]);

  const base = {
    host,
    repository,
    action,
    sender: login(payload["sender"]),
    technicalUser,
  };

  const keyOf = (...parts: readonly unknown[]): string =>
    [repository, action, ...parts].map(String).join(" ");

  switch (kind) {
    case "issues": {
      const issue = fieldsOf(payload["issue"]);

      return {
        name: "issue",
        key: keyOf(
          "issue",
          issue["number"],
          fieldsOf(payload["label"])["name"],
          stampOf(action, issue),
        ),
        fields: {
          ...base,
          ...authored(issue),
          number: number(issue["number"]),
          title: text(issue["title"]),
          body: clipped(issue["body"]),
          url: text(issue["html_url"]),
          labels: labels(issue["labels"]),
          label: text(fieldsOf(payload["label"])["name"]),
        },
      };
    }

    case "issue_comment":
    case "pull_request_review_comment": {
      const comment = fieldsOf(payload["comment"]);
      const subject = fieldsOf(payload["issue"] ?? payload["pull_request"]);
      const body = clipped(comment["body"]);

      return {
        name: "comment",
        key: keyOf("comment", comment["id"], stampOf(action, comment)),
        fields: {
          ...base,
          ...authored(comment),
          number: number(subject["number"]),
          pullRequest:
            kind === "pull_request_review_comment" ||
            subject["pull_request"] !== undefined,
          body,
          command: /^\/[\w-]+/.exec(body)?.[0] ?? "",
          url: text(comment["html_url"]),
        },
      };
    }

    case "pull_request": {
      const pull = fieldsOf(payload["pull_request"]);

      return {
        name: "pull_request",
        key: keyOf(
          "pull_request",
          pull["number"],
          fieldsOf(payload["label"])["name"],
          stampOf(action, pull),
        ),
        fields: {
          ...base,
          ...authored(pull),
          number: number(pull["number"]),
          title: text(pull["title"]),
          body: clipped(pull["body"]),
          url: text(pull["html_url"]),
          branch: text(fieldsOf(pull["head"])["ref"]),
          base: text(fieldsOf(pull["base"])["ref"]),
          merged: pull["merged"] === true,
          labels: labels(pull["labels"]),
          label: text(fieldsOf(payload["label"])["name"]),
        },
      };
    }

    case "pull_request_review": {
      const review = fieldsOf(payload["review"]);

      return {
        name: "review",
        key: keyOf("review", review["id"]),
        fields: {
          ...base,
          ...authored(review),
          number: number(fieldsOf(payload["pull_request"])["number"]),
          state: text(review["state"]).toLowerCase(),
          body: clipped(review["body"]),
          url: text(review["html_url"]),
        },
      };
    }

    case "check_run": {
      const run = fieldsOf(payload["check_run"]);

      return {
        name: "check",
        key: keyOf("check", run["id"]),
        fields: {
          ...base,
          name: text(run["name"]),
          conclusion: text(run["conclusion"]),
          branch: text(fieldsOf(run["check_suite"])["head_branch"]),
          sha: text(run["head_sha"]),
          numbers: (Array.isArray(run["pull_requests"])
            ? run["pull_requests"]
            : []
          ).map((each: unknown) => number(fieldsOf(each)["number"])),
          url: text(run["html_url"]),
        },
      };
    }

    case "push": {
      const ref = text(payload["ref"]);

      // A tag's push is its tag event.
      if (!ref.startsWith("refs/heads/")) {
        return undefined;
      }

      const commits = Array.isArray(payload["commits"])
        ? payload["commits"]
        : [];

      const paths = commits.flatMap((each: unknown) => {
        const commit = fieldsOf(each);

        return ["added", "modified", "removed"].flatMap((change) =>
          strings(commit[change]),
        );
      });

      return {
        name: "push",
        key: keyOf("push", ref, payload["after"]),
        fields: {
          ...base,
          branch: ref.slice("refs/heads/".length),
          sha: text(payload["after"]),
          paths: [...new Set(paths)].sort(),
        },
      };
    }

    case "create":
    case "delete": {
      if (payload["ref_type"] !== "tag") {
        return undefined;
      }

      const tag = text(payload["ref"]);
      const tagAction = kind === "create" ? "created" : "deleted";

      return {
        name: "tag",
        key: [repository, tagAction, "tag", tag].join(" "),
        fields: { ...base, action: tagAction, tag },
      };
    }

    case "release": {
      const release = fieldsOf(payload["release"]);

      return {
        name: "release",
        key: keyOf("release", release["id"]),
        fields: {
          ...base,
          tag: text(release["tag_name"]),
          title: text(release["name"]),
          body: clipped(release["body"]),
          url: text(release["html_url"]),
          prerelease: release["prerelease"] === true,
          author: login(release["author"]),
        },
      };
    }

    case "deployment": {
      const deployment = fieldsOf(payload["deployment"]);

      return {
        name: "deployment",
        key: keyOf("deployment", deployment["id"]),
        fields: {
          ...base,
          id: number(deployment["id"]),
          environment: text(deployment["environment"]),
          ref: text(deployment["ref"]),
          sha: text(deployment["sha"]),
          description: clipped(deployment["description"]),
        },
      };
    }

    default:
      return undefined;
  }
}

function authored(item: Fields): { author: string; member: boolean } {
  return {
    author: login(item["user"]),
    member: ["OWNER", "MEMBER", "COLLABORATOR"].includes(
      text(item["author_association"]),
    ),
  };
}

// When the change happened, as the item says it.
function stampOf(action: string, item: Fields): string {
  switch (action) {
    case "opened":
    case "created":
      return text(item["created_at"]);
    case "closed":
      return text(item["closed_at"]);
    default:
      return text(item["updated_at"]);
  }
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap((each: unknown) =>
    typeof each === "string" ? [each] : [],
  );
}

function labels(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((each: unknown) =>
    text(fieldsOf(each)["name"]),
  );
}

function login(value: unknown): string {
  return text(fieldsOf(value)["login"]);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function clipped(value: unknown): string {
  const body = text(value);

  return body.length > maxBody ? `${body.slice(0, maxBody)}…` : body;
}

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsOf(value: unknown): Fields {
  return isObject(value) ? value : {};
}
