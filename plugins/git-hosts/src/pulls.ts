import { HostRefused, reach } from "./github";
import type { HostConfig } from "./hosts";

// owner/name#number on a host.
export interface PullRef {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export interface Check {
  readonly name: string;
  readonly status: "pending" | "passed" | "failed";
  readonly url: string | null;
}

// A review, or a comment on a line, by someone.
export interface Remark {
  readonly id: string;
  readonly author: string;
  readonly kind: "approved" | "changes_requested" | "commented" | "line";
  readonly body: string;
  readonly url: string;
  readonly path: string | null;
}

export interface PullState {
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly head: string;
  // null while the host still works it out.
  readonly conflicts: boolean | null;
  readonly checks: readonly Check[];
  readonly remarks: readonly Remark[];
}

// Answers kept by URL with their ETag, so an unchanged answer comes back as
// a 304, which GitHub doesn't count against the rate limit.
export type Answers = Map<string, { readonly etag: string; body: unknown }>;

// https://github.com/owner/name/pull/12, on any host.
export function pullRefOf(url: string): PullRef | undefined {
  const parsed = URL.parse(url);

  const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(
    parsed?.pathname ?? "",
  );

  return parsed === null || match?.[1] === undefined || match[2] === undefined
    ? undefined
    : {
        host: parsed.host.toLowerCase(),
        repository: match[1],
        number: Number(match[2]),
      };
}

export async function pullStateOf(
  host: HostConfig,
  token: string,
  ref: PullRef,
  answers: Answers,
): Promise<PullState> {
  const get = async (path: string): Promise<unknown> => {
    const url = `${host.api}/repos/${ref.repository}${path}`;
    const known = answers.get(url);

    const response = await reach(host, url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(known && { "if-none-match": known.etag }),
      },
    });

    if (response.status === 304 && known !== undefined) {
      return known.body;
    }

    if (!response.ok) {
      throw new HostRefused(
        `${host.host} answered ${String(response.status)} to ${path}`,
      );
    }

    const body: unknown = await response.json();
    const etag = response.headers.get("etag");

    if (etag !== null) {
      answers.set(url, { etag, body });
    }

    return body;
  };

  const pull = (await get(`/pulls/${String(ref.number)}`)) as {
    html_url?: string;
    title?: string;
    state?: string;
    merged?: boolean;
    mergeable?: boolean | null;
    head?: { sha?: string };
  };

  const head = pull.head?.sha ?? "";

  const [runs, statuses, reviews, comments] = await Promise.all([
    get(`/commits/${head}/check-runs?per_page=100`),
    get(`/commits/${head}/status`),
    get(`/pulls/${String(ref.number)}/reviews?per_page=100`),
    get(
      `/pulls/${String(ref.number)}/comments?per_page=100&sort=created&direction=desc`,
    ),
  ]);

  return {
    url: pull.html_url ?? "",
    title: pull.title ?? "",
    state: stateOf(pull),
    head,
    conflicts: typeof pull.mergeable === "boolean" ? !pull.mergeable : null,
    checks: [...checkRuns(runs), ...commitStatuses(statuses)],
    remarks: [...reviewsIn(reviews), ...lineComments(comments)],
  };
}

// The repository's merge methods, the first one it allows first.
export async function mergePull(
  host: HostConfig,
  token: string,
  ref: PullRef,
): Promise<void> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
  };

  const repository = await reach(host, `${host.api}/repos/${ref.repository}`, {
    headers,
  });

  const allowed = (await repository.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const method =
    ["squash", "merge", "rebase"].find(
      (each) => allowed[`allow_${each}_merge`] === true,
    ) ?? "merge";

  const merged = await reach(
    host,
    `${host.api}/repos/${ref.repository}/pulls/${String(ref.number)}/merge`,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ merge_method: method }),
    },
  );

  if (!merged.ok) {
    const { message } = (await merged.json().catch(() => ({}))) as {
      message?: unknown;
    };

    throw new HostRefused(
      typeof message === "string"
        ? `${host.host} didn't merge it: ${message}`
        : `${host.host} answered ${String(merged.status)} to the merge`,
    );
  }
}

function checkRuns(body: unknown): readonly Check[] {
  const { check_runs: runs } = (body ?? {}) as { check_runs?: unknown };

  return listOf(runs).flatMap((run) => {
    const {
      name,
      status,
      conclusion,
      html_url: url,
    } = run as {
      name?: unknown;
      status?: unknown;
      conclusion?: unknown;
      html_url?: unknown;
    };

    if (typeof name !== "string") {
      return [];
    }

    return [
      {
        name,
        status: runStatus(status, conclusion),
        url: typeof url === "string" ? url : null,
      },
    ];
  });
}

function commitStatuses(body: unknown): readonly Check[] {
  const { statuses } = (body ?? {}) as { statuses?: unknown };

  return listOf(statuses).flatMap((each) => {
    const {
      context,
      state,
      target_url: url,
    } = each as {
      context?: unknown;
      state?: unknown;
      target_url?: unknown;
    };

    if (typeof context !== "string") {
      return [];
    }

    return [
      {
        name: context,
        status: statusOf[String(state)] ?? "failed",
        url: typeof url === "string" ? url : null,
      },
    ];
  });
}

const reviewKinds: Readonly<Record<string, Remark["kind"]>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};

function reviewsIn(body: unknown): readonly Remark[] {
  return listOf(body).flatMap((review) => {
    const {
      id,
      user,
      state,
      body: text,
      html_url: url,
    } = review as {
      id?: unknown;
      user?: { login?: unknown };
      state?: unknown;
      body?: unknown;
      html_url?: unknown;
    };

    const kind = reviewKinds[String(state)];

    return kind === undefined || typeof id !== "number"
      ? []
      : [
          {
            id: `review-${String(id)}`,
            author: typeof user?.login === "string" ? user.login : "",
            kind,
            body: typeof text === "string" ? text : "",
            url: typeof url === "string" ? url : "",
            path: null,
          },
        ];
  });
}

function lineComments(body: unknown): readonly Remark[] {
  return listOf(body).flatMap((comment) => {
    const {
      id,
      user,
      body: text,
      html_url: url,
      path,
    } = comment as {
      id?: unknown;
      user?: { login?: unknown };
      body?: unknown;
      html_url?: unknown;
      path?: unknown;
    };

    return typeof id !== "number"
      ? []
      : [
          {
            id: `comment-${String(id)}`,
            author: typeof user?.login === "string" ? user.login : "",
            kind: "line" as const,
            body: typeof text === "string" ? text : "",
            url: typeof url === "string" ? url : "",
            path: typeof path === "string" ? path : null,
          },
        ];
  });
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stateOf(pull: {
  readonly state?: string;
  readonly merged?: boolean;
}): PullState["state"] {
  if (pull.merged === true) {
    return "merged";
  }

  return pull.state === "closed" ? "closed" : "open";
}

function runStatus(status: unknown, conclusion: unknown): Check["status"] {
  if (status !== "completed") {
    return "pending";
  }

  return ["success", "neutral", "skipped"].includes(String(conclusion))
    ? "passed"
    : "failed";
}

const statusOf: Readonly<Record<string, Check["status"]>> = {
  success: "passed",
  pending: "pending",
};
