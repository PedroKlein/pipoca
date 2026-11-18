import {
  ago,
  Slot,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
  useViewer,
} from "@pipoca/plugins/web";
import {
  Avatar,
  Button,
  cardClass,
  cn,
  EmptyState,
  ErrorText,
  Page,
  Segmented,
  Switch,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ActivityItem,
  type ActivityKind,
  type ActivitySettings,
  type ActivityTopic,
  headline,
} from "../src/artifacts";

type View = "mine" | "following";

const kindLabels: Readonly<Record<ActivityKind, string>> = {
  mention: "Mention",
  review: "Review",
  reply: "Reply",
  comment: "Comment",
};

const docLabels = { design: "Design doc", spec: "Spec", plan: "Plan" };

const topics: readonly { topic: ActivityTopic; label: string }[] = [
  { topic: "asked", label: "Mentions and review requests" },
  { topic: "replies", label: "Replies in threads I'm in" },
  { topic: "comments", label: "Every new comment on my artifacts" },
];

// What happened on artifacts the person sees: what's for them, or
// everything they follow, and what they ask to be told of.
export function ActivityPage(): ReactElement {
  const api = useApi(plugin);
  const viewer = useViewer();
  const now = useNow();
  const { open } = useOverlay();
  const [view, setView] = useState<View>("mine");
  const [problem, setProblem] = useState<string>();

  const { value, reload } = useLoaded(
    async () =>
      api.get<{ items: ActivityItem[]; unread: number }>(
        `activity?view=${view}`,
      ),
    `activity:${view}`,
    { changes: ["artifacts"] },
  );

  const run = (action: Promise<unknown>): void => {
    setProblem(undefined);

    action.then(reload, (failed: unknown) => {
      setProblem(failed instanceof Error ? failed.message : String(failed));
    });
  };

  const items = value?.items ?? [];

  return (
    <Page
      title={
        <>
          Activity
          <span className="sr-only">, {viewer.person.name}</span>
        </>
      }
      actions={
        <div className="flex items-center gap-2">
          <Segmented
            label="Show"
            value={view}
            options={[
              { value: "mine", label: "For you" },
              { value: "following", label: "Everything I follow" },
            ]}
            onChange={setView}
          />
          {view === "mine" && (
            <Button
              variant="ghost"
              disabled={(value?.unread ?? 0) === 0}
              onClick={() => {
                run(api.post("activity/read", {}));
              }}
            >
              Mark all read
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorText size="caption">{problem}</ErrorText>
        {value !== undefined && items.length === 0 ? (
          <EmptyState>
            {view === "mine"
              ? "Nothing for you yet. Mentions, review requests and replies in your threads show here."
              : "Nothing to follow yet. Comments on your artifacts, threads you wrote in and docs you review show here."}
          </EmptyState>
        ) : (
          <ul
            aria-label="Activity"
            className={cn(
              cardClass,
              "divide-y divide-line overflow-hidden p-0",
            )}
          >
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-describedby={`${item.id}-detail`}
                  onClick={() => {
                    if (!item.read) {
                      void api.post("activity/read", { ids: [item.id] });
                    }

                    open({
                      artifact: item.artifact,
                      comments: "1",
                      ...(item.thread !== null && { thread: item.thread }),
                    });
                  }}
                  className="flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left hover:bg-hover"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-3 size-1.5 shrink-0 rounded-full",
                      item.read ? "bg-transparent" : "bg-butter",
                    )}
                  />
                  <Avatar name={item.by} pi={item.byPi} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-ui text-fg-strong">
                      {item.read ? (
                        ""
                      ) : (
                        <span className="sr-only">Unread: </span>
                      )}
                      {headline(item)}
                    </span>
                    <span
                      id={`${item.id}-detail`}
                      className="truncate text-caption text-fg-dim"
                    >
                      {detail(item, now)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-md bg-hover px-2 py-0.5 text-caption text-fg-dim">
                    {kindLabels[item.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ActivitySettingsCard />
      </div>
    </Page>
  );
}

function detail(item: ActivityItem, now: number): string {
  const said = item.excerpt === "" ? [] : [`“${item.excerpt}”`];

  const on =
    item.quote === ""
      ? []
      : [
          `thread on ${item.quote.length > 30 ? `${item.quote.slice(0, 29)}…` : item.quote}`,
        ];

  const parts: Readonly<Record<ActivityKind, readonly string[]>> = {
    mention: [...said, ...on],
    review: [
      item.doc === null ? "Doc" : docLabels[item.doc],
      `version ${String(item.version)}`,
    ],
    reply: said,
    comment: ["Your artifact"],
  };

  return [...parts[item.kind], ago(new Date(item.at).toISOString(), now)].join(
    " · ",
  );
}

function ActivitySettingsCard(): ReactElement {
  const api = useApi(plugin);
  const [problem, setProblem] = useState<string>();

  const { value, reload } = useLoaded(
    async () => api.get<ActivitySettings>("activity/settings"),
    "activity:settings",
  );

  return (
    <section
      aria-labelledby="activity-settings"
      className={cn(cardClass, "flex max-w-155 flex-col gap-3 px-4.5 py-4")}
    >
      <h2 id="activity-settings" className="text-ui font-medium text-fg-strong">
        Tell me about artifact activity
      </h2>
      <ul className="flex flex-col gap-2.5">
        {topics.map(({ topic, label }) => (
          <li key={topic} className="flex items-center gap-3 text-ui text-fg">
            <span className="flex-1">{label}</span>
            <span className="text-caption text-fg-dim">
              Here
              <Slot name="activity.channel" topic={topic} />
            </span>
            <Switch
              label={label}
              labelHidden
              checked={value?.[topic] ?? false}
              disabled={value === undefined}
              onChange={(on) => {
                setProblem(undefined);

                api
                  .put("activity/settings", { topic, on })
                  .then(reload, (failed: unknown) => {
                    setProblem(
                      failed instanceof Error ? failed.message : String(failed),
                    );
                  });
              }}
            />
          </li>
        ))}
      </ul>
      <ErrorText size="caption">{problem}</ErrorText>
    </section>
  );
}

// How many things for the person they haven't read, beside the sidebar's
// entry.
export function ActivityCount(): ReactElement | null {
  const api = useApi(plugin);

  const { value } = useLoaded(
    async () =>
      api.get<{ items: ActivityItem[]; unread: number }>("activity?view=mine"),
    "activity:mine",
    { changes: ["artifacts"] },
  );

  if (value === undefined || value.unread === 0) {
    return null;
  }

  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-md bg-butter/40 px-1 text-caption text-fg-strong">
      {value.unread}
      <span className="sr-only"> unread</span>
    </span>
  );
}
