import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  ChoiceTiles,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  Icon,
  Select,
  Switch,
  TextInput,
} from "@pipoca/ui";
import type { DeclaredEvent, PluginInfo } from "@pipoca/protocol";
import { type ReactElement, useState } from "react";
import { routines } from "../plugin";
import type { RoutineDetail, WouldFire } from "../src/model";
import { changes } from "./common";
import {
  fieldsOf,
  heardLabel,
  heardWhen,
  type Json,
  listOf,
  nounOf,
  objectOf,
  type Operator,
  operatorLabels,
  operators,
  put,
  runEnded,
  stringOf,
  triggerSummary,
  typed,
} from "./sentence";

const eventPattern = /^[a-z0-9-]+\.[a-z0-9_]+$/;

// The events the owner heard in the last days that the trigger would have
// fired on, from what the server keeps for test on save (ADR 0076).
export function useWouldFire(
  prefix: string,
  trigger: Json,
  group: string | undefined,
): WouldFire | undefined {
  const api = useApi(routines);

  const ready =
    trigger["kind"] === "event" &&
    eventPattern.test(stringOf(trigger["event"]));

  const body = { trigger, ...(group !== undefined && { group }) };

  return useLoaded(
    async () =>
      ready
        ? api.post<WouldFire>(`${prefix}heard`, body).catch(() => undefined)
        : undefined,
    `heard-${prefix}${JSON.stringify(body)}`,
    { changes },
  ).value;
}

export function useEvents(): readonly DeclaredEvent[] | undefined {
  const api = useApi(routines);

  return useLoaded(async () => api.get<DeclaredEvent[]>("events"), "events")
    .value;
}

// An event's fields by name and type, with the output fields the routine
// a routines.run_ended trigger follows declares (ADR 0075).
export function useFields(
  prefix: string,
  trigger: Json,
  event: DeclaredEvent | undefined,
): Readonly<Record<string, string>> {
  const api = useApi(routines);

  const followed =
    trigger["event"] === runEnded
      ? stringOf(
          listOf(trigger["where"])
            .map(objectOf)
            .find((each) => each["field"] === "routine" && "is" in each)?.[
            "is"
          ],
        )
      : "";

  const output = useLoaded(
    async () =>
      followed === ""
        ? undefined
        : api
            .get<RoutineDetail>(
              `${prefix}routines/${encodeURIComponent(followed)}`,
            )
            .then(
              (detail) => detail.routine?.output,
              () => undefined,
            ),
    `output-${prefix}${followed}`,
  ).value;

  const own = fieldsOf(event?.fields);

  const outputs = Object.fromEntries(
    Object.entries(output ?? {}).map(([name, type]) => [
      `output.${name}`,
      typeof type === "string" ? type : type[0],
    ]),
  );

  return { ...own, ...outputs };
}

interface Source {
  readonly plugin: string;
  readonly title: string;
  readonly events: readonly DeclaredEvent[];
}

function sourcesOf(
  events: readonly DeclaredEvent[],
  plugins: readonly PluginInfo[],
): readonly Source[] {
  const ids = [...new Set(events.map(({ type }) => pluginOf(type)))];

  return ids.map((plugin) => ({
    plugin,
    title:
      plugin === "routines"
        ? "Your routines"
        : (plugins.find(({ id }) => id === plugin)?.title ?? plugin),
    events: events.filter(({ type }) => pluginOf(type) === plugin),
  }));
}

function pluginOf(type: string): string {
  return type.slice(0, type.indexOf("."));
}

// Picking an event trigger in full (ADR 0075): the plugin it comes from,
// its event, conditions on its declared fields, who may fire it, and the
// recent events it would have fired on, one of which saving can test on.
export function EventTrigger({
  prefix,
  trigger,
  group,
  groupTitle,
  testOn,
  onCancel,
  onAdd,
}: {
  readonly prefix: string;
  readonly trigger: Json;
  readonly group: string | undefined;
  readonly groupTitle: string | undefined;
  readonly testOn: string | undefined;
  readonly onCancel: () => void;
  readonly onAdd: (trigger: Json, testOn: string | undefined) => void;
}): ReactElement {
  const api = useApi(routines);
  const [made, setMade] = useState(trigger);
  const [picked, setPicked] = useState(testOn);
  const events = useEvents() ?? [];

  const plugins =
    useLoaded(async () => api.get<PluginInfo[]>("/api/plugins"), "plugins", {
      topics: ["plugins"],
    }).value ?? [];

  const sources = sourcesOf(events, plugins);
  const type = stringOf(made["event"]);
  const source = sources.find(({ plugin }) => plugin === pluginOf(type));
  const event = events.find((each) => each.type === type);
  const fields = useFields(prefix, made, event);
  const where = listOf(made["where"]).map(objectOf);
  const heard = useWouldFire(prefix, made, group);
  const gitHost = type.startsWith("git-hosts.");

  const members = !where.some(
    (each) => each["field"] === "member" || each["field"] === "sender",
  );

  const setWhere = (next: readonly Json[]): void => {
    setMade(put(made, "where", next.length === 0 ? undefined : next));
  };

  const pick = (to: string): void => {
    setPicked(undefined);

    setMade({
      kind: "event",
      event: to,
      ...(to === runEnded && { where: [{ field: "routine", is: "" }] }),
    });
  };

  const listed = heard?.events.slice(0, 5) ?? [];
  const noun = nounOf(made, event).replace(/^(a|an) /, "");

  return (
    <>
      <div className="max-h-[calc(100dvh-180px)] overflow-y-auto">
        <DialogBody className="gap-5.5">
          <div className="flex flex-col gap-2">
            <span className="text-label font-medium text-fg">From</span>
            <ChoiceTiles
              label="From"
              name="source"
              columns={3}
              tiles={sources.map((each) => ({
                value: each.plugin,
                title: each.title,
                description: each.events.map(({ title }) => title).join(", "),
              }))}
              value={source?.plugin}
              onChange={(plugin) => {
                const first = sources.find((each) => each.plugin === plugin)
                  ?.events[0]?.type;

                if (first !== undefined) {
                  pick(first);
                }
              }}
            />
            <p className="text-label text-fg-dim">
              Each comes from a plugin that declared its events and their
              fields.
            </p>
          </div>
          {source !== undefined && (
            <div className="flex flex-col gap-2">
              <span className="text-label font-medium text-fg">Event</span>
              <div
                role="group"
                aria-label="Event"
                className="inline-flex max-w-full gap-0.5 self-start overflow-x-auto rounded-[10px] bg-hover p-0.75"
              >
                {source.events.map((each) => (
                  <button
                    key={each.type}
                    type="button"
                    aria-pressed={each.type === type}
                    onClick={() => {
                      pick(each.type);
                    }}
                    className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-[7px] px-3 text-label font-medium text-fg-dim transition-colors hover:text-fg aria-pressed:bg-elevated aria-pressed:text-fg-strong aria-pressed:shadow-xs"
                  >
                    {each.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {event !== undefined && (
            <div className="flex flex-col gap-2">
              <span className="text-label font-medium text-fg">Only if</span>
              <ConditionRows
                where={where}
                fields={fields}
                onChange={setWhere}
              />
              <p className="text-label text-fg-dim">
                Fields come from the event&apos;s declaration, so a typo
                can&apos;t be saved. All conditions must hold.
              </p>
            </div>
          )}
          {gitHost && (
            <div className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui font-medium text-fg-strong">
                  Only from repository members
                </span>
                <span className="text-label text-fg-dim">
                  Anyone can open {nounOf(made, event)}. Off means strangers can
                  start runs on your tokens.
                </span>
              </span>
              <Switch
                label="Only from repository members"
                labelHidden
                checked={members}
                onChange={(on) => {
                  const rest = where.filter(
                    (each) =>
                      each["field"] !== "member" && each["field"] !== "sender",
                  );

                  setWhere(
                    on
                      ? rest
                      : [...rest, { field: "member", oneOf: [true, false] }],
                  );
                }}
              />
            </div>
          )}
          {event !== undefined && (
            <div className="flex flex-col gap-2">
              <span className="text-label font-medium text-fg">
                Would have fired, last 7 days
              </span>
              <ul
                aria-label="Would have fired"
                className={cn(cardClass, "flex flex-col divide-y divide-line")}
              >
                {listed.map((each) => (
                  <li
                    key={each.id}
                    className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-ui"
                  >
                    <span className="min-w-0 flex-1 text-fg">
                      {heardLabel(each)}
                    </span>
                    <span className="text-label text-fg-dim">
                      {heardWhen(each)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={picked === each.id}
                      onClick={() => {
                        setPicked(picked === each.id ? undefined : each.id);
                      }}
                    >
                      {picked === each.id
                        ? "Tests with this"
                        : "Test with this"}
                    </Button>
                  </li>
                ))}
                <li className="px-3.5 py-2.5 text-label text-fg-dim">
                  {heard === undefined
                    ? "Looking at the events of the last 7 days…"
                    : [
                        heard.count > listed.length &&
                          `${String(heard.count - listed.length)} more.`,
                        heard.count === 0 &&
                          `No ${noun} event of the last 7 days matches.`,
                        `${String(heard.others)} other ${noun} events didn't match.`,
                      ]
                        .filter((part) => typeof part === "string")
                        .join(" ")}
                </li>
              </ul>
            </div>
          )}
        </DialogBody>
      </div>
      <DialogFoot>
        <span className="min-w-0 flex-1 text-label text-fg-dim">
          {event === undefined ? "" : triggerSummary(made, event, groupTitle)}
        </span>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={event === undefined}
          onClick={() => {
            onAdd(made, picked);
          }}
        >
          Add trigger
        </Button>
      </DialogFoot>
    </>
  );
}

// The event trigger's dialog, "When an event happens".
export function EventTriggerDialog({
  open,
  ...props
}: Parameters<typeof EventTrigger>[0] & {
  readonly open: boolean;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={props.onCancel}
      title="When an event happens"
      size="lg"
    >
      <EventTrigger {...props} />
    </Dialog>
  );
}

// One row for each condition: a declared field, a test and a value.
export function ConditionRows({
  where,
  fields,
  onChange,
}: {
  readonly where: readonly Json[];
  readonly fields: Readonly<Record<string, string>>;
  readonly onChange: (where: readonly Json[]) => void;
}): ReactElement {
  const names = Object.keys(fields);

  return (
    <div className={cn(cardClass, "flex flex-col divide-y divide-line")}>
      {where.map((each, index) => {
        const operator: Operator =
          operators.find((name) => name in each) ?? "is";

        const field = stringOf(each["field"]);
        const type = fields[field];

        const replace = (next: Json): void => {
          onChange(where.map((one, at) => (at === index ? next : one)));
        };

        return (
          <div
            key={index}
            className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5"
            aria-label={`Condition ${String(index + 1)}`}
            role="group"
          >
            {names.length > 0 ? (
              <Select
                aria-label="Field"
                value={field}
                onChange={(event) => {
                  replace({ ...each, field: event.target.value });
                }}
                className="w-44"
              >
                {!names.includes(field) && (
                  <option value={field}>{field}</option>
                )}
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                aria-label="Field"
                value={field}
                onChange={(event) => {
                  replace({ ...each, field: event.target.value });
                }}
                className="w-44"
              />
            )}
            <Select
              aria-label="Test"
              value={operator}
              onChange={(event) => {
                replace({
                  field,
                  [event.target.value]: each[operator] ?? "",
                });
              }}
              className="w-36"
            >
              {operators.map((name) => (
                <option key={name} value={name}>
                  {operatorLabels[name]}
                </option>
              ))}
            </Select>
            <TextInput
              aria-label="Value"
              value={
                operator === "oneOf"
                  ? listOf(each["oneOf"]).map(stringOf).join(", ")
                  : stringOf(each[operator])
              }
              onChange={(event) => {
                const text = event.target.value;

                replace({
                  field,
                  [operator]:
                    operator === "oneOf"
                      ? text.split(",").map((one) => typed(one.trim(), type))
                      : typed(text, type),
                });
              }}
              className="min-w-40 flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove condition ${String(index + 1)}`}
              onClick={() => {
                onChange(where.filter((_, at) => at !== index));
              }}
            >
              <Icon name="x" />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange([...where, { field: names[0] ?? "", is: "" }]);
          }}
        >
          <Icon name="plus" />
          Add condition
        </Button>
        <span className="flex-1" />
        <span className="text-label text-fg-dim">
          {operators
            .filter((name) => name !== "matches")
            .map((name) => operatorLabels[name])
            .join(" · ")}
        </span>
      </div>
    </div>
  );
}
