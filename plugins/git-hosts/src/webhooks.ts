import { createHmac, timingSafeEqual } from "node:crypto";
import { fieldsOf, isObject } from "@pipoca/plugins";

type Fields = Readonly<Record<string, unknown>>;

// The longest body text an event carries. Routines put events in a prompt.
const maxBody = 4000;

// Whether GitHub signed the body with the App's webhook secret, as
// sha256=<HMAC-SHA256 in hex> in X-Hub-Signature-256.
export function signedWith(
  secret: string,
  body: string,
  signature: string | null,
): boolean {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );

  const given = Buffer.from(signature ?? "");

  return given.length === expected.length && timingSafeEqual(given, expected);
}

// A GitHub webhook as one of the plugin's events, or undefined for those it
// doesn't pass on. Every event says which repository it is about and whether
// whoever caused it is a member of it, since anyone who can reach a public
// repository can open an issue or comment (ADR 0061).
export function eventOf(
  host: string,
  kind: string,
  payload: unknown,
): (Fields & { readonly type: `git-hosts.${string}` }) | undefined {
  if (!isObject(payload) || !isObject(payload["repository"])) {
    return undefined;
  }

  const base = {
    host,
    repository: text(payload["repository"]["full_name"]),
    action: text(payload["action"]),
    sender: login(payload["sender"]),
  };

  switch (kind) {
    case "issues": {
      const issue = record(payload["issue"]);

      return {
        type: "git-hosts.issue",
        ...base,
        ...authored(issue),
        number: issue["number"],
        title: text(issue["title"]),
        body: clipped(issue["body"]),
        url: text(issue["html_url"]),
        labels: labels(issue["labels"]),
        label: text(record(payload["label"])["name"]),
      };
    }

    case "issue_comment":
    case "pull_request_review_comment": {
      const comment = record(payload["comment"]);
      const subject = record(payload["issue"] ?? payload["pull_request"]);
      const body = clipped(comment["body"]);

      return {
        type: "git-hosts.comment",
        ...base,
        ...authored(comment),
        number: subject["number"],
        pullRequest:
          kind === "pull_request_review_comment" ||
          subject["pull_request"] !== undefined,
        body,
        command: /^\/[\w-]+/.exec(body)?.[0] ?? "",
        url: text(comment["html_url"]),
      };
    }

    case "pull_request": {
      const pull = record(payload["pull_request"]);

      return {
        type: "git-hosts.pull_request",
        ...base,
        ...authored(pull),
        number: pull["number"],
        title: text(pull["title"]),
        body: clipped(pull["body"]),
        url: text(pull["html_url"]),
        branch: text(record(pull["head"])["ref"]),
        base: text(record(pull["base"])["ref"]),
        merged: pull["merged"] === true,
        labels: labels(pull["labels"]),
        label: text(record(payload["label"])["name"]),
      };
    }

    case "pull_request_review": {
      const review = record(payload["review"]);

      return {
        type: "git-hosts.review",
        ...base,
        ...authored(review),
        number: record(payload["pull_request"])["number"],
        state: text(review["state"]).toLowerCase(),
        body: clipped(review["body"]),
        url: text(review["html_url"]),
      };
    }

    case "check_run": {
      const run = record(payload["check_run"]);

      return {
        type: "git-hosts.check",
        ...base,
        name: text(run["name"]),
        conclusion: text(run["conclusion"]),
        branch: text(record(run["check_suite"])["head_branch"]),
        sha: text(run["head_sha"]),
        numbers: (Array.isArray(run["pull_requests"])
          ? run["pull_requests"]
          : []
        ).map((each: unknown) => record(each)["number"]),
        url: text(run["html_url"]),
      };
    }

    case "push":
      return {
        type: "git-hosts.push",
        ...base,
        branch: text(payload["ref"]).replace(/^refs\/heads\//, ""),
        sha: text(payload["after"]),
      };

    default:
      return undefined;
  }
}

function authored(item: Fields): Fields {
  return {
    author: login(item["user"]),
    member: ["OWNER", "MEMBER", "COLLABORATOR"].includes(
      text(item["author_association"]),
    ),
  };
}

function labels(value: unknown): readonly string[] {
  return (Array.isArray(value) ? value : []).map((each: unknown) =>
    text(record(each)["name"]),
  );
}

function login(value: unknown): string {
  return text(record(value)["login"]);
}

function record(value: unknown): Fields {
  return fieldsOf(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clipped(value: unknown): string {
  const body = text(value);

  return body.length > maxBody ? `${body.slice(0, maxBody)}…` : body;
}
