import { useNow } from "@pipoca/plugins/web";
import type { HubPage, Session } from "@pipoca/protocol";
import {
  Badge,
  Button,
  cardClass,
  cn,
  ErrorText,
  Icon,
  Page,
  plural,
  Row,
  Rows,
  Section,
  Select,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { ago, sessionBadge, shortName } from "../names";
import { href } from "../router";
import { PluginBoundary } from "../plugin-boundary";
import { panels } from "./hub-pages";

const busy = new Set<Session["status"]>(["queued", "starting", "running"]);

// Home shows this panel beside Running now, as a column of its own.
const sidePanel = "usage/activity";

export function LayoutPage({
  page,
  sessions,
  admin,
  error,
  onStart,
  onChange,
  onRemove,
}: {
  readonly page: HubPage;
  readonly sessions: readonly Session[];
  readonly admin: boolean;
  readonly error: string | undefined;
  readonly onStart: () => void;
  readonly onChange: (page: HubPage) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const available = panels();
  const home = page.id === "home";

  const shown = page.panels.flatMap((id) => {
    const panel = available.find((each) => each.id === id);

    return panel === undefined ? [] : [panel];
  });

  const missing = available.filter(({ id }) => !page.panels.includes(id));
  const side = home ? shown.find(({ id }) => id === sidePanel) : undefined;
  const bottom = shown.filter((panel) => panel !== side);

  const running = sessions.filter(
    ({ status, waiting }) => !waiting && busy.has(status),
  );

  const move = (index: number, by: number): void => {
    const next = [...page.panels];
    const [moved] = next.splice(index, 1);

    if (moved !== undefined) {
      next.splice(index + by, 0, moved);
      onChange({ ...page, panels: next });
    }
  };

  return (
    <Page
      wide
      title={home ? "Team home" : page.title}
      description={
        home
          ? "What the team is working on now. Team work runs on the team's Profiles, Environments and keys."
          : undefined
      }
      actions={
        <>
          {admin && (
            <Button
              aria-pressed={editing}
              onClick={() => {
                setEditing(!editing);
              }}
            >
              {editing ? "Done" : "Edit layout"}
            </Button>
          )}
          {home && (
            <Button variant="primary" onClick={onStart}>
              <Icon name="plus" />
              Start team work
            </Button>
          )}
        </>
      }
    >
      <ErrorText className="mb-4">{error}</ErrorText>
      {editing && (
        <Section
          title="Panels on this page"
          actions={
            home ? undefined : (
              <Button variant="danger" onClick={onRemove}>
                Remove page
              </Button>
            )
          }
        >
          <Rows label="Panels on this page">
            {page.panels.map((id, index) => (
              <Row
                key={id}
                title={available.find((each) => each.id === id)?.title ?? id}
                description={id}
              >
                <Button
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  disabled={index === page.panels.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    onChange({
                      ...page,
                      panels: page.panels.filter((each) => each !== id),
                    });
                  }}
                >
                  Remove
                </Button>
              </Row>
            ))}
          </Rows>
          {missing.length > 0 && (
            <Select
              aria-label="Add a panel"
              value=""
              onChange={(event) => {
                onChange({
                  ...page,
                  panels: [...page.panels, event.target.value],
                });
              }}
            >
              <option value="" disabled>
                Add a panel
              </option>
              {missing.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </Select>
          )}
        </Section>
      )}
      {home && (
        <>
          <Section
            title="Needs someone"
            description="Any of you can pick these up"
          >
            <SessionRows
              sessions={sessions.filter(({ waiting }) => waiting)}
              empty="Nothing is waiting on the team."
            />
          </Section>
          <div className="grid gap-x-6 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <Section
              title="Running now"
              description={plural(running.length, "Session")}
            >
              <SessionRows
                sessions={running}
                empty="No team work is running."
              />
            </Section>
            {side && (
              <section
                aria-label={side.title}
                className="mt-8 flex flex-col gap-2.5"
              >
                <h2 className="flex min-h-8 items-center text-prose font-semibold text-fg-strong">
                  {side.title}
                </h2>
                <div className={cn(cardClass, "p-4")}>
                  <PluginBoundary name={side.plugin}>
                    <side.Panel />
                  </PluginBoundary>
                </div>
              </section>
            )}
          </div>
        </>
      )}
      {(home || bottom.length > 0) && (
        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {home && (
            <PanelCard title="Pull requests">
              <p className="text-label text-fg-dim">
                No pull requests to show yet.
              </p>
            </PanelCard>
          )}
          {bottom.map(({ id, title, plugin, Panel }) => (
            <PanelCard key={id} title={title}>
              <PluginBoundary name={plugin}>
                <Panel />
              </PluginBoundary>
            </PanelCard>
          ))}
        </div>
      )}
      {!home && shown.length === 0 && !editing && (
        <p className="text-label text-fg-dim">
          {admin
            ? "No panels here yet. Edit the layout to add some."
            : "No panels here yet."}
        </p>
      )}
    </Page>
  );
}

function PanelCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      aria-label={title}
      className={cn(cardClass, "flex min-w-0 flex-col gap-2.5 p-4")}
    >
      <h2 className="text-prose font-semibold text-fg-strong">{title}</h2>
      {children}
    </section>
  );
}

export function TeamSessions({
  sessions,
}: {
  readonly sessions: readonly Session[];
}): ReactElement {
  return (
    <Page
      title="Sessions"
      description="Every Session the team has, newest first. Anyone on the team can open one."
    >
      <SessionRows sessions={sessions} empty="The team has no Sessions yet." />
    </Page>
  );
}

function SessionRows({
  sessions,
  empty,
}: {
  readonly sessions: readonly Session[];
  readonly empty: ReactNode;
}): ReactElement {
  const now = useNow();

  if (sessions.length === 0) {
    return <p className="text-label text-fg-dim">{empty}</p>;
  }

  return (
    <Rows>
      {sessions.map((session) => {
        const badge = sessionBadge(session);

        return (
          <Row
            key={session.id}
            title={
              <a
                href={href("teamSession", { id: session.id })}
                className="hover:underline focus-visible:underline"
              >
                {session.title ?? shortName(session.workspace)}
              </a>
            }
            description={`${shortName(session.workspace)} · ${ago(session.createdAt, now)}`}
          >
            {badge && <Badge state={badge.state}>{badge.label}</Badge>}
          </Row>
        );
      })}
    </Rows>
  );
}
