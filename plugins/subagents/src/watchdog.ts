import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { SessionContext } from "@pipoca/plugins";
import { noticeType, type ThinkingLevel } from "@pipoca/protocol";
import { thinkingLevel } from "./agents";
import {
  type Finding,
  type Importance,
  type Review,
  watchdogKind,
} from "./format";

interface Settings {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

const tools = ["read", "grep", "find", "ls"];
const stuckAfter = 3;
const promptsKept = 8;
const promptKept = 2000;
const guidanceKept = 8000;
const diffKept = 20_000;

const instructions = `You are a watchdog. Another agent has just changed a repository for a person. Review the change and report only real problems: correctness bugs, requirements from the person's messages it missed, unsafe changes, missing tests, and claims the change doesn't back.

- Read the files around the change when the diff alone isn't enough. Don't change anything.
- Skip style preferences and anything you aren't sure is wrong.
- Answer with only a JSON array of findings, and [] when there is nothing worth raising. Each finding is {"importance": "low" | "medium" | "high", "summary": "...", "evidence": "...", "action": "..."}.
- high: the agent must fix it before it is done. medium: worth fixing. low: worth knowing.`;

// Reviews what each turn changed in the working tree, when the Profile's Pi
// settings turn it on (ADR 0058). High findings go back to the agent; the
// rest are for the person only.
export function watchdog(
  s: Pick<SessionContext, "startChild">,
  pi: ExtensionAPI,
): void {
  const prompts: string[] = [];
  let baseline: string | undefined;
  let lastHigh: string | undefined;
  let repeats = 0;

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType === "user") {
      prompts.push(event.prompt.slice(0, promptKept));
      prompts.splice(0, Math.max(0, prompts.length - promptsKept));
      lastHigh = undefined;
      repeats = 0;
    }

    baseline = settingsOf(pi.getSettings())
      ? await snapshot(ctx.cwd)
      : undefined;

    return undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const settings = settingsOf(pi.getSettings());
    const start = baseline;

    if (!settings || start === undefined || event.outcome !== "completed") {
      return undefined;
    }

    const end = await snapshot(ctx.cwd);
    if (end === undefined || end === start) {
      return undefined;
    }

    baseline = end;

    const review = await reviewed(
      s,
      settings,
      ctx.signal,
      task(prompts, await guidance(ctx), await changes(ctx.cwd, start, end)),
    );

    const high = highOf(review);

    if (high === "") {
      lastHigh = undefined;
      repeats = 0;
    } else {
      repeats = high === lastHigh ? repeats + 1 : 1;
      lastHigh = high;
    }

    const shown: Review =
      repeats >= stuckAfter && high !== ""
        ? { ...review, stuck: true }
        : review;

    if (shown.findings.length === 0 && shown.error === undefined) {
      return undefined;
    }

    return {
      entries: [
        {
          type: "custom_message",
          customType: noticeType,
          content: reviewText(shown),
          display: true,
          details: { plugin: "subagents", kind: watchdogKind, data: shown },
        },
      ],
      continue: forModel(shown) !== undefined,
    };
  });

  pi.on("context", ({ messages }) => ({
    messages: messages.flatMap<(typeof messages)[number]>((message) => {
      if (message.role !== "custom") {
        return [message];
      }

      const review = reviewOf(message);
      if (review === undefined) {
        return [message];
      }

      const sent = forModel(review);

      return sent === undefined ? [] : [{ ...message, content: sent }];
    }),
  }));
}

function settingsOf(settings: unknown): Settings | undefined {
  const { subagents } = settings as { readonly subagents?: unknown };

  const { watchdog: found } = (subagents ?? {}) as {
    readonly watchdog?: unknown;
  };

  if (typeof found !== "object" || found === null) {
    return undefined;
  }

  // pi-subagents keeps them under main.
  const { enabled, main, ...rest } = found as Readonly<Record<string, unknown>>;

  const { model, thinking } = { ...rest, ...(main ?? {}) } as {
    readonly model?: unknown;
    readonly thinking?: unknown;
  };

  const level = thinkingLevel(thinking);

  return enabled === true
    ? {
        ...(typeof model === "string" && model !== "" && { model }),
        ...(level !== undefined && { thinking: level }),
      }
    : undefined;
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        done(error ? undefined : stdout);
      },
    );
  });
}

// The working tree as a git tree, untracked files included, without touching
// the repository's own index. Undefined outside a repository.
async function snapshot(cwd: string): Promise<string | undefined> {
  const index = await git(cwd, ["rev-parse", "--git-path", "index"]);
  if (index === undefined) {
    return undefined;
  }

  const folder = await mkdtemp(join(tmpdir(), "pipoca-watchdog-"));
  const copy = join(folder, "index");

  try {
    await copyFile(resolve(cwd, index.trim()), copy).catch(() => undefined);

    const env = { GIT_INDEX_FILE: copy };
    if ((await git(cwd, ["add", "--all"], env)) === undefined) {
      return undefined;
    }

    return (await git(cwd, ["write-tree"], env))?.trim();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function changes(
  cwd: string,
  start: string,
  end: string,
): Promise<string> {
  const stat = (await git(cwd, ["diff", "--stat", start, end])) ?? "";
  const diff = (await git(cwd, ["diff", start, end])) ?? "";

  return diff.length > diffKept
    ? `${stat}\n${diff.slice(0, diffKept)}\n\n(The diff goes on. Read the files above for the rest.)`
    : `${stat}\n${diff}`;
}

// WATCHDOG.md from a trusted project's .pi folder and from the Profile.
async function guidance(ctx: {
  readonly cwd: string;
  readonly isProjectTrusted: () => boolean;
}): Promise<string> {
  const files = [
    ...(ctx.isProjectTrusted() ? [join(ctx.cwd, ".pi", "WATCHDOG.md")] : []),
    join(getAgentDir(), "WATCHDOG.md"),
  ];

  const found = await Promise.all(
    files.map(async (file) => readFile(file, "utf8").catch(() => "")),
  );

  return found
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n\n")
    .slice(0, guidanceKept);
}

function task(
  prompts: readonly string[],
  standing: string,
  diff: string,
): string {
  return [
    "## What the person asked",
    prompts.length === 0 ? "(nothing yet)" : prompts.join("\n\n---\n\n"),
    ...(standing === "" ? [] : ["## Standing instructions", standing]),
    "## The change",
    `\`\`\`diff\n${diff}\n\`\`\``,
  ].join("\n\n");
}

async function reviewed(
  s: Pick<SessionContext, "startChild">,
  settings: Settings,
  signal: AbortSignal | undefined,
  prompt: string,
): Promise<Review> {
  try {
    const session = await s.startChild({
      tools,
      ...settings,
      systemPrompt: instructions,
    });

    const abort = (): void => {
      void session.abort();
    };

    signal?.addEventListener("abort", abort);

    try {
      await session.prompt(prompt);
    } finally {
      signal?.removeEventListener("abort", abort);
      session.dispose();
    }

    const reply = session.messages.findLast(
      (message) => message.role === "assistant",
    );

    const text =
      reply?.role === "assistant"
        ? reply.content
            .flatMap((p) => (p.type === "text" ? [p.text] : []))
            .join("")
        : "";

    const findings = parseFindings(text);

    return findings === undefined
      ? { findings: [], error: "The watchdog didn't answer with findings." }
      : { findings };
  } catch (error) {
    return {
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const importances: readonly string[] = ["low", "medium", "high"];

function parseFindings(text: string): readonly Finding[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end < start) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  return parsed.flatMap((item: unknown): Finding[] => {
    const { importance, summary, evidence, action } = (item ?? {}) as Readonly<
      Record<string, unknown>
    >;

    return typeof importance === "string" &&
      importances.includes(importance) &&
      typeof summary === "string"
      ? [
          {
            importance: importance as Importance,
            summary,
            evidence: typeof evidence === "string" ? evidence : "",
            action: typeof action === "string" ? action : "",
          },
        ]
      : [];
  });
}

function highOf(review: Review): string {
  return review.findings
    .filter(({ importance }) => importance === "high")
    .map(({ summary }) => summary.trim())
    .sort()
    .join("\n");
}

function reviewOf(message: {
  readonly customType: string;
  readonly details?: unknown;
}): Review | undefined {
  if (message.customType !== noticeType) {
    return undefined;
  }

  const { plugin, kind, data } = (message.details ?? {}) as {
    readonly plugin?: unknown;
    readonly kind?: unknown;
    readonly data?: Review;
  };

  return plugin === "subagents" && kind === watchdogKind ? data : undefined;
}

function findingText({
  importance,
  summary,
  evidence,
  action,
}: Finding): string {
  return [
    `- ${importance}: ${summary}`,
    ...(evidence === "" ? [] : [`  Evidence: ${evidence}`]),
    ...(action === "" ? [] : [`  Action: ${action}`]),
  ].join("\n");
}

function reviewText(review: Review): string {
  if (review.error !== undefined) {
    return `The watchdog couldn't review this turn: ${review.error}`;
  }

  return [
    review.stuck === true
      ? "The watchdog keeps finding the same problem, so it stopped sending it to the agent:"
      : "The watchdog reviewed this turn's changes:",
    ...review.findings.map(findingText),
  ].join("\n");
}

// What the model sees of a review: its high findings, until they are stuck.
function forModel(review: Review): string | undefined {
  const high = review.findings.filter(
    ({ importance }) => importance === "high",
  );

  if (review.stuck === true || high.length === 0) {
    return undefined;
  }

  return [
    "A watchdog reviewed the changes you just made and found problems you must address. Fix them, or say why a finding is wrong:",
    ...high.map(findingText),
  ].join("\n");
}
