import { usage } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import type { ReactElement } from "react";

export interface Totals {
  readonly team: { readonly cost: number };
  readonly mine: { readonly cost: number };
  readonly budgets: {
    readonly team: number | null;
    readonly person: number | null;
  };
}

export const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

// The team's spend against its budget, and the viewer's share (ADR 0066).
export function Spend(): ReactElement {
  const api = useApi(usage);

  const { value: totals } = useLoaded(
    async () => api.get<Totals>("totals"),
    "totals",
    { changes: ["totals"] },
  );

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
