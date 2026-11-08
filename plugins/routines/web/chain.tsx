import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  type BadgeState,
  Button,
  Cell,
  cardClass,
  cn,
  Code,
  Section,
  Segmented,
  Table,
} from "@pipoca/ui";
import type { DeclaredEvent } from "@pipoca/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import { routines } from "../plugin";
import type {
  Proposal,
  ProposalState,
  RoutineDetail,
  RoutineView,
  Run,
} from "../src/model";
import { changes, OutcomeBadge, pageAt, type Scope } from "./common";
import { RunResults } from "./extras";
import {
  type Follower,
  followsRoutine,
  followWords,
  maxDepth,
  outputTypeWords,
  runEnded,
  shortTime,
  thenOf,
  triggerWords,
} from "./words";

// The routines that follow this one, with their triggers, and the names of
// the owner's routines to their titles.
export function useChain(
  scope: Scope,
  routine: RoutineDetail | undefined,
): {
  readonly followers: readonly Follower[];
  readonly titleOf: (name: string) => string;
  readonly events: readonly DeclaredEvent[];
} {
  const api = useApi(routines);
  const feeds = routine?.feeds ?? [];

  const list = useLoaded(
    async () => api.get<RoutineView[]>(`${scope.prefix}routines`),
    `${scope.prefix}routines`,
    { changes },
  ).value;

  const events = useLoaded(
    async () => api.get<DeclaredEvent[]>("events"),
    "events",
  ).value;

  const loaded = useLoaded(
    async () =>
      Promise.all(
        feeds.map(async (name) =>
          api.get<RoutineDetail>(
            `${scope.prefix}routines/${encodeURIComponent(name)}`,
          ),
        ),
      ),
    `followers-${scope.prefix}${feeds.join(",")}`,
    { changes },
  ).value;

  const titleOf = (name: string): string =>
    (Array.isArray(list) ? list : []).find((each) => each.name === name)
      ?.title ?? name;

  const followers = feeds.map((name, index) => {
    const found = loaded?.[index];

    return {
      name,
      title: found?.title ?? titleOf(name),
      ...(found?.routine !== undefined && { routine: found.routine }),
    };
  });

  return {
    followers,
    titleOf,
    events: Array.isArray(events) ? events : [],
  };
}

function Arrow(): ReactElement {
  return (
    <svg
      viewBox="0 0 40 16"
      aria-hidden="true"
      className="m-auto h-4 w-10 rotate-90 text-fg-dim md:rotate-0"
    >
      <path
        d="M2 8h32M28 3l6 5-6 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

interface Link {
  readonly title: string;
  readonly detail: string;
  readonly href?: string;
}

function ChainCard({
  label,
  links,
  current = false,
}: {
  readonly label: string;
  readonly links: readonly Link[];
  readonly current?: boolean;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        cardClass,
        "flex min-w-0 flex-col gap-2 px-4 py-3.5",
        current && "border-accent ring-3 ring-focus",
      )}
    >
      <span className="text-caption font-medium text-fg-dim">{label}</span>
      {links.map((link) => (
        <span key={link.title + link.detail} className="flex flex-col gap-0.5">
          {link.href === undefined ? (
            <span className="text-ui font-medium text-fg-strong">
              {link.title}
            </span>
          ) : (
            <a
              href={link.href}
              className="text-ui font-medium text-fg-strong hover:underline"
            >
              {link.title}
            </a>
          )}
          <span className="text-label text-fg-dim">{link.detail}</span>
        </span>
      ))}
    </div>
  );
}

const kindWords = {
  schedule: "Schedule",
  once: "Once",
  event: "Event",
  webhook: "Webhook",
  watch: "Watch",
} as const;

// What feeds the routine, the routine with its output, and what it feeds
// (ADR 0075).
export function ChainStrip({
  scope,
  routine,
  chain,
}: {
  readonly scope: Scope;
  readonly routine: RoutineDetail;
  readonly chain: ReturnType<typeof useChain>;
}): ReactElement | null {
  const when = routine.routine?.when;

  if (when === undefined) {
    return null;
  }

  const fedBy = when.map((trigger): Link => {
    const source =
      trigger.kind === "event" && trigger.event === runEnded
        ? routine.fedBy.find((name) => followsRoutine(trigger, name))
        : undefined;

    return source === undefined
      ? {
          title: kindWords[trigger.kind],
          detail: triggerWords(trigger, chain.titleOf, chain.events),
        }
      : {
          title: chain.titleOf(source),
          detail: followWords(trigger),
          href: pageAt(`${scope.prefix}${source}`),
        };
  });

  const output = Object.keys(routine.routine?.output ?? {});

  const feeds = chain.followers.map((follower): Link => {
    const trigger = follower.routine?.when.find((each) =>
      followsRoutine(each, routine.name),
    );

    return {
      title: follower.title,
      detail: trigger === undefined ? "When it ends" : followWords(trigger),
      href: pageAt(`${scope.prefix}${follower.name}`),
    };
  });

  return (
    <Section
      title="Chain"
      description="built from triggers, nothing to set here"
    >
      <div className="grid grid-cols-1 items-stretch gap-1 md:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)_40px_minmax(0,1fr)] md:gap-0">
        <ChainCard label="Fed by" links={fedBy} />
        <Arrow />
        <ChainCard
          label="This routine"
          current
          links={[
            {
              title: routine.title,
              detail:
                output.length === 0
                  ? "No declared output"
                  : `Output: ${output.join(", ")}`,
            },
          ]}
        />
        <Arrow />
        <ChainCard
          label="Feeds"
          links={
            feeds.length === 0
              ? [
                  {
                    title: "Nothing yet",
                    detail: "A routine that runs after this one shows here.",
                  },
                ]
              : feeds
          }
        />
      </div>
      <p className="text-label text-fg-dim">
        A run started by a chain carries its depth. Past {maxDepth} deep, the
        next routine is skipped and you get one notice.
      </p>
    </Section>
  );
}

export function OutputSection({
  routine,
  onEdit,
}: {
  readonly routine: RoutineDetail;
  readonly onEdit: () => void;
}): ReactElement {
  const fields = Object.entries(routine.routine?.output ?? {});

  return (
    <Section
      title="Output"
      description="what end_run hands to the next routine"
      actions={
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit fields
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <dl className={cn(cardClass, "flex flex-col gap-2 px-4 py-3.5")}>
          {fields.length === 0 && (
            <p className="text-label text-fg-dim">No fields declared.</p>
          )}
          {fields.map(([name, type]) => (
            <div key={name} className="flex gap-2.5">
              <dt className="min-w-20 text-ui font-medium text-fg-strong">
                {name}
              </dt>
              <dd className="text-label text-fg-dim">
                {outputTypeWords(type)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-label leading-relaxed text-fg-dim">
          Optional. Declared fields make the output checked: end_run refuses
          output that doesn&apos;t fit, and routines that listen can filter on
          these fields in the picker. Without them, the summary and any output
          go on unchecked.
        </p>
      </div>
    </Section>
  );
}

type Show = "all" | "you" | "failed";

const failedOutcomes: readonly string[] = ["failed", "blocked", "stopped"];

function needsYou(run: Run): boolean {
  return (
    run.outcome === "waiting" ||
    (run.proposals ?? []).some(({ state }) => state === "waiting")
  );
}

const causeWords: Readonly<Record<string, string>> = {
  "by hand": "Run now",
};

export function RunsTable({
  scope,
  routine,
  chain,
  act,
}: {
  readonly scope: Scope;
  readonly routine: RoutineDetail;
  readonly chain: ReturnType<typeof useChain>;
  readonly act: (action: string, body?: object) => void;
}): ReactElement {
  const [show, setShow] = useState<Show>("all");

  const shown = routine.runs.filter(
    (run) =>
      show === "all" ||
      (show === "you" ? needsYou(run) : failedOutcomes.includes(run.outcome)),
  );

  return (
    <Section
      title="Runs"
      actions={
        <Segmented
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: "All" },
            { value: "you", label: "Needs you" },
            { value: "failed", label: "Failed" },
          ]}
        />
      }
    >
      {shown.length === 0 && (
        <p className="text-fg-dim">
          {routine.runs.length === 0 ? "No runs yet." : "No runs here."}
        </p>
      )}
      {shown.length > 0 && (
        <Table
          label="Runs"
          columns={[
            "Fired",
            "Outcome",
            "Summary",
            "Then",
            <span key="actions" className="sr-only">
              Actions
            </span>,
          ]}
        >
          {shown.map((run) => (
            <RunRow
              key={run.id}
              href={pageAt(
                `${scope.prefix}${routine.name}/${run.sessionId ?? ""}`,
              )}
              run={run}
              then={
                <ThenCell
                  scope={scope}
                  run={run}
                  routine={routine}
                  chain={chain}
                />
              }
              act={act}
            />
          ))}
        </Table>
      )}
    </Section>
  );
}

function ThenCell({
  scope,
  run,
  routine,
  chain,
}: {
  readonly scope: Scope;
  readonly run: Run;
  readonly routine: RoutineDetail;
  readonly chain: ReturnType<typeof useChain>;
}): ReactElement {
  const then = thenOf(run, routine, routine.group, chain.followers);

  if (then.kind === "none") {
    return <span className="text-label text-fg-dim">{then.text}</span>;
  }

  return (
    <span className="text-label">
      Fed{" "}
      {then.followers.map((follower, index) => (
        <span key={follower.name}>
          {index > 0 && ", "}
          <a
            href={pageAt(`${scope.prefix}${follower.name}`)}
            className="text-fg underline"
          >
            {follower.title}
          </a>
        </span>
      ))}
    </span>
  );
}

function RunRow({
  href,
  run,
  then,
  act,
}: {
  readonly href: string;
  readonly run: Run;
  readonly then: ReactNode;
  readonly act: (action: string, body?: object) => void;
}): ReactElement {
  const fired = (
    <>
      <time dateTime={run.firedAt} className="block whitespace-nowrap">
        {shortTime(run.firedAt)}
      </time>
      <span className="block text-label text-fg-dim">
        {causeWords[run.cause] ?? run.cause}
        {run.depth === undefined ? "" : `, ${String(run.depth)} deep`}
      </span>
    </>
  );

  return (
    <tr>
      <Cell className="align-top">
        {run.sessionId === null ? (
          fired
        ) : (
          <a href={href} className="block text-fg hover:underline">
            {fired}
          </a>
        )}
      </Cell>
      <Cell className="align-top">
        <span className="flex flex-wrap gap-1">
          <OutcomeBadge outcome={run.outcome} />
          {run.dryRun === true && <Badge state="offline">Dry run</Badge>}
        </span>
      </Cell>
      <Cell className="align-top">
        {run.reason !== null && <span className="text-fg">{run.reason}</span>}
        {run.questions !== undefined && run.questions.length > 0 && (
          <ul aria-label="Questions" className="flex flex-col gap-1 py-1">
            {run.questions.map((question) => (
              <li key={question.id} className="flex flex-col text-label">
                <span className="text-fg">{question.prompts.join(" ")}</span>
                <span className="text-fg-dim">
                  {run.askedFor !== undefined && run.askedFor.length > 0
                    ? `For ${run.askedFor.join(", ")}. `
                    : ""}
                  Waits until {new Date(question.closesAt).toLocaleString()}.
                </span>
              </li>
            ))}
          </ul>
        )}
        {run.proposals !== undefined && run.proposals.length > 0 && (
          <ul
            aria-label="Proposals"
            className="flex flex-col gap-1 py-1 text-label"
          >
            {run.proposals.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} act={act} />
            ))}
          </ul>
        )}
        <RunResults run={run} />
      </Cell>
      <Cell className="align-top">{then}</Cell>
      <Cell className="text-right align-top">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Replay the run of ${new Date(run.firedAt).toLocaleString()}`}
          onClick={() => {
            act(`runs/${run.id}/replay`, {});
          }}
        >
          Replay
        </Button>
      </Cell>
    </tr>
  );
}

const proposalStates: Readonly<
  Record<ProposalState, { readonly state: BadgeState; readonly label: string }>
> = {
  proposed: { state: "waiting", label: "Proposed" },
  waiting: { state: "waiting", label: "Waiting for approval" },
  applied: { state: "done", label: "Applied" },
  failed: { state: "failed", label: "Failed" },
  rejected: { state: "offline", label: "Rejected" },
  refused: { state: "failed", label: "Refused" },
  shown: { state: "offline", label: "Not applied: dry run" },
};

// What a run proposed, exactly as it would be written, and where it stands.
function ProposalRow({
  proposal,
  act,
}: {
  readonly proposal: Proposal;
  readonly act: (action: string, body?: object) => void;
}): ReactElement {
  const { state, label } = proposalStates[proposal.state];

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge state={state}>{label}</Badge>
        <span className="text-fg">{proposal.title}</span>
        {proposal.url !== null && (
          <a
            href={proposal.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-fg-dim hover:underline"
          >
            {proposal.url}
          </a>
        )}
        {proposal.result !== null && proposal.url === null && (
          <span className="min-w-0 truncate text-fg-dim">
            {proposal.result}
          </span>
        )}
      </div>
      <Code label={`What ${proposal.title} writes`} wrap>
        {JSON.stringify(proposal.input, null, 2)}
      </Code>
      {proposal.state === "waiting" && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              act(`proposals/${proposal.id}/approve`);
            }}
          >
            Approve
          </Button>
          <Button
            onClick={() => {
              act(`proposals/${proposal.id}/reject`);
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}
