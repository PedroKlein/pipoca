import type { Static } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";

type Defined = (typeof gitHosts)["events"];

// One of the plugin's events, by its name and fields.
export type HostEvent = {
  [N in keyof Defined]: {
    readonly name: N;
    readonly fields: Static<Defined[N]["fields"]>;
  };
}[keyof Defined];

type Fields = Readonly<Record<string, unknown>>;

// The longest body text an event carries. Routines put events in a prompt.
const maxBody = 4000;

// A GitHub webhook as one of the plugin's events, or undefined for those it
// doesn't pass on. Every event says which repository it is about and whether
// whoever caused it is a member of it, since anyone who can reach a public
// repository can open an issue or comment (ADR 0061).
export function eventOf(
  host: string,
  technicalUser: string,
  kind: string,
  payload: unknown,
): HostEvent | undefined {
  if (!isObject(payload) || !isObject(payload["repository"])) {
    return undefined;
  }

  const base = {
    host,
    repository: text(payload["repository"]["full_name"]),
    action: text(payload["action"]),
    sender: login(payload["sender"]),
    technicalUser,
  };

  switch (kind) {
    case "issues": {
      const issue = fieldsOf(payload["issue"]);

      return {
        name: "issue",
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

    case "push":
      return {
        name: "push",
        fields: {
          ...base,
          branch: text(payload["ref"]).replace(/^refs\/heads\//, ""),
          sha: text(payload["after"]),
        },
      };

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
