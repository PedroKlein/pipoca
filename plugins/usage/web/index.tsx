import {
  json,
  type SessionPartProps,
  watchChanges,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { type ReactElement, useEffect, useState } from "react";
import { addUsage, describeContext, describeUsage, type Usage } from "./usage";

export const usage: WebPlugin = {
  name: "usage",
  SessionHeader,
  hub: { panels: { spend: { title: "Spend this month", Panel: Spend } } },
};

interface Totals {
  readonly team: { readonly cost: number };
  readonly mine: { readonly cost: number };
  readonly budgets: {
    readonly team: number | null;
    readonly person: number | null;
  };
}

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

// The team's spend against its budget, and the viewer's share (ADR 0066).
function Spend({ context }: { readonly context: WebContext }): ReactElement {
  const [totals, setTotals] = useState<Totals>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const read = (): void => {
      json<Totals>(context.request("totals")).then(
        setTotals,
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    };

    read();

    return watchChanges(["usage.totals"], read);
  }, [context]);

  if (error !== undefined) {
    return <p className="text-label text-failed">{error}</p>;
  }

  if (totals === undefined) {
    return <p className="text-label text-fg-dim">Loading…</p>;
  }

  const { team, person } = totals.budgets;

  const share =
    team === null ? undefined : Math.min(totals.team.cost / team, 1);

  return (
    <div className="flex flex-col gap-2">
      {share !== undefined && (
        <div
          role="meter"
          aria-label="Team budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-2 overflow-hidden rounded-full bg-hover"
        >
          <div
            className={share >= 0.8 ? "h-full bg-waiting" : "h-full bg-working"}
            style={{ width: `${String(share * 100)}%` }}
          />
        </div>
      )}
      <p className="text-label text-fg-dim">
        <b className="font-medium text-fg-strong">
          {dollars.format(totals.team.cost)}
        </b>
        {team === null ? " by the team" : ` of ${dollars.format(team)}`}, you
        used {dollars.format(totals.mine.cost)}
        {person === null ? "" : ` of your ${dollars.format(person)} cap`}.
      </p>
    </div>
  );
}

interface Context {
  readonly tokens: number | null;
  readonly window: number;
}

// A ring for how full the context is and the cost so far, like Claude Code's
// context meter. The numbers behind them show on hover.
function SessionHeader({ session }: SessionPartProps): ReactElement {
  const [totals, setTotals] = useState<ReadonlyMap<string, Usage>>(new Map());
  const [context, setContext] = useState<Context>();

  useEffect(() => {
    let lines = 0;

    return session.events((event) => {
      if (event.type === "live" && event.event.type === "context") {
        setContext({ tokens: event.event.tokens, window: event.event.window });

        return;
      }

      if (event.type !== "entry" || event.line < lines) {
        return;
      }

      lines = event.line + 1;

      setTotals((current) => addUsage(current, event.entry));
    });
  }, [session]);

  const { summary, detail, cost } = describeUsage(totals);

  const title = [
    ...(context === undefined
      ? []
      : [`${describeContext(context.tokens, context.window)} context`]),
    ...(summary === "" ? [] : [summary]),
    ...(totals.size > 1 ? [detail] : []),
  ].join("\n");

  const used =
    context?.tokens === null || context === undefined
      ? undefined
      : Math.min(context.tokens / context.window, 1);

  return (
    <span title={title} className="flex items-center gap-3 tabular-nums">
      {used !== undefined && (
        <span className="flex items-center gap-1.5">
          <Ring used={used} />
          {Math.round(used * 100)}%
        </span>
      )}
      {totals.size > 0 && <span>{cost}</span>}
    </span>
  );
}

function Ring({ used }: { readonly used: number }): ReactElement {
  const length = 2 * Math.PI * 6;

  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2.5"
        className="stroke-line-strong"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${String(used * length)} ${String(length)}`}
        className={used > 0.8 ? "stroke-waiting" : "stroke-fg-dim"}
      />
    </svg>
  );
}
