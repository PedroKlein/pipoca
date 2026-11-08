import {
  type ToolPermissionProps,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import { Badge, Button, Card, Notice } from "@pipoca/ui";
import type { ReactElement } from "react";
import { routines } from "../plugin";
import type { GroupView } from "../src/model";
import { openInForm } from "./create";
import {
  actsLine,
  chipClass,
  heardLabel,
  listOf,
  objectOf,
  Sentence,
  sentenceOf,
  stringOf,
} from "./sentence";
import { useEvents, useWouldFire } from "./trigger";

interface Named {
  readonly id: string;
  readonly name: string;
}

// The routines tool asks before it creates, changes or removes a routine
// (ADR 0050, ADR 0075). For a routine it shows the routine as a card, with
// the question and its answers under it.
export function RoutineApproval({
  title,
  input,
  onAnswer,
}: ToolPermissionProps): ReactElement {
  const call = objectOf(input);
  const action = stringOf(call["action"]);
  const routine = objectOf(call["routine"]);
  const name = stringOf(call["name"]);
  const team = title.includes("team routine");
  const prefix = team ? "team/" : "";
  const showsRoutine = action === "create" || action === "update";

  return (
    <div className="flex flex-col gap-3">
      {showsRoutine && (
        <RoutineCard
          prefix={prefix}
          routine={routine}
          name={name}
          group={stringOf(call["group"])}
        />
      )}
      <Notice
        tone="waiting"
        icon="info"
        className="items-center"
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onAnswer("deny");
              }}
            >
              Not now
            </Button>
            <Button
              variant={action === "remove" ? "danger" : "primary"}
              size="sm"
              onClick={() => {
                onAnswer("once");
              }}
            >
              {{ create: "Create", update: "Change", remove: "Delete" }[
                action
              ] ?? "Allow"}
            </Button>
          </div>
        }
      >
        <h2 className="text-ui text-fg">
          {title}
          {action === "create" && (
            <TestedOn
              prefix={prefix}
              routine={routine}
              group={stringOf(call["group"])}
            />
          )}
        </h2>
      </Notice>
    </div>
  );
}

function TestedOn({
  prefix,
  routine,
  group,
}: {
  readonly prefix: string;
  readonly routine: Readonly<Record<string, unknown>>;
  readonly group: string;
}): ReactElement | null {
  const trigger = objectOf(listOf(routine["when"])[0]);

  const newest = useWouldFire(prefix, trigger, group || undefined)?.events[0];

  return newest === undefined ? null : (
    <> It tests once now on {heardLabel(newest)}.</>
  );
}

function RoutineCard({
  prefix,
  routine,
  name,
  group,
}: {
  readonly prefix: string;
  readonly routine: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly group: string;
}): ReactElement {
  const api = useApi(routines);
  const events = useEvents();
  const team = prefix !== "";

  const groups =
    useLoaded(
      async () => api.get<GroupView[]>(`${prefix}groups`),
      `${prefix}groups`,
    ).value ?? [];

  const profiles =
    useLoaded(
      async () =>
        api.get<Named[]>(`/api/profiles?scope=${team ? "team" : "mine"}`),
      `profiles-${prefix}`,
      { topics: ["profiles"] },
    ).value ?? [];

  const profile = stringOf(objectOf(routine["do"])["profile"]);
  const groupTitle = groups.find((each) => each.name === group)?.title;

  return (
    <Card
      role="region"
      aria-label="Routine"
      className="flex flex-col gap-3 px-5 py-4.5"
    >
      <div className="flex items-center gap-2.5">
        <Badge>{team ? "Team routine" : "Routine"}</Badge>
        <span className="min-w-0 flex-1 truncate text-center text-ui font-medium text-fg-strong">
          {stringOf(routine["title"]) || name}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            openInForm(prefix, routine, name);
          }}
        >
          Open in form
        </Button>
      </div>
      <p className="text-prose leading-[2] text-fg">
        <Sentence
          phrases={sentenceOf(routine, {
            events,
            group: groupTitle ?? (group || undefined),
          })}
          chip={(_, label) => <span className={chipClass}>{label}</span>}
        />
      </p>
      <span className="text-label text-fg-dim">
        {actsLine(routine, {
          team,
          profile: profiles.find(({ id }) => id === profile)?.name ?? profile,
        })}
      </span>
    </Card>
  );
}
