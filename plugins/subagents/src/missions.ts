import { randomUUID } from "node:crypto";
import type { Decision, MissionView } from "./format";

export interface MissionChange {
  readonly title?: string;
  readonly objective?: string;
  readonly decision?: {
    readonly question: string;
    readonly options?: readonly string[];
  };
  readonly receipt?: { readonly label: string; readonly url: string };
  readonly close?: string;
}

export interface Missions {
  readonly create: (title: string, objective: string) => MissionView;
  readonly update: (
    id: string,
    change: MissionChange,
  ) => MissionView | undefined;
  readonly attach: (id: string, runId: string) => boolean;
  readonly decide: (
    id: string,
    decisionId: string,
    answer: string,
  ) =>
    { readonly mission: MissionView; readonly decision: Decision } | undefined;
  readonly keep: (id: string, state: unknown) => void;
  readonly get: (id: string) => MissionView | undefined;
  readonly restore: (missions: readonly MissionView[]) => void;
  readonly list: () => readonly MissionView[];
}

// The Session's missions. Every change calls recorded, so the caller can keep
// it in the transcript and publish it.
export function missions({
  recorded,
  now,
}: {
  readonly recorded: (mission: MissionView) => void;
  readonly now: () => number;
}): Missions {
  const all = new Map<string, MissionView>();

  const set = (mission: MissionView): MissionView => {
    all.set(mission.id, mission);
    recorded(mission);

    return mission;
  };

  const open = (id: string): MissionView | undefined => {
    const mission = all.get(id);

    return mission?.closedAt === undefined ? mission : undefined;
  };

  return {
    create: (title, objective) =>
      set({
        id: randomUUID().slice(0, 8),
        title,
        objective,
        createdAt: now(),
        runIds: [],
        decisions: [],
        receipts: [],
      }),
    update: (id, { title, objective, decision, receipt, close }) => {
      const mission = open(id);
      if (!mission) {
        return undefined;
      }

      return set({
        ...mission,
        ...(title !== undefined && { title }),
        ...(objective !== undefined && { objective }),
        decisions:
          decision === undefined
            ? mission.decisions
            : [
                ...mission.decisions,
                {
                  id: String(mission.decisions.length + 1),
                  question: decision.question,
                  options: decision.options ?? [],
                },
              ],
        receipts:
          receipt === undefined
            ? mission.receipts
            : [...mission.receipts, receipt],
        ...(close !== undefined && { closedAt: now(), summary: close }),
      });
    },
    attach: (id, runId) => {
      const mission = open(id);
      if (!mission) {
        return false;
      }

      set({ ...mission, runIds: [...mission.runIds, runId] });

      return true;
    },
    decide: (id, decisionId, answer) => {
      const mission = open(id);

      const asked = mission?.decisions.find(
        (d) => d.id === decisionId && d.answer === undefined,
      );

      if (!mission || !asked) {
        return undefined;
      }

      const decision = { ...asked, answer };

      return {
        mission: set({
          ...mission,
          decisions: mission.decisions.map((d) =>
            d.id === decisionId ? decision : d,
          ),
        }),
        decision,
      };
    },
    keep: (id, state) => {
      const mission = all.get(id);
      if (mission) {
        set({ ...mission, state });
      }
    },
    get: (id) => all.get(id),
    restore: (restored) => {
      for (const mission of restored) {
        all.set(mission.id, mission);
      }
    },
    list: () => [...all.values()],
  };
}
