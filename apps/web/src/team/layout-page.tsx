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
  PageTitle,
  Row,
  Rows,
  Section,
  Select,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { ago, sessionBadge, shortName } from "../names";
import { href } from "../router";
import { PluginBoundary } from "../plugin-boundary";
import { pluginContext } from "../plugins";
import { panels } from "./hub-pages";

const busy = new Set<Session["status"]>(["queued", "starting", "running"]);

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

  const move = (index: number, by: number): void => {
    const next = [...page.panels];
    const [moved] = next.splice(index, 1);

    if (moved !== undefined) {
      next.splice(index + by, 0, moved);
      onChange({ ...page, panels: next });
    }
  };

  return (
    <Page wide>
      <PageTitle
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
        {home ? "Team home" : page.title}
      </PageTitle>
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
          <Section title="Running now">
            <SessionRows
              sessions={sessions.filter(
                ({ status, waiting }) => !waiting && busy.has(status),
              )}
              empty="No team work is running."
            />
          </Section>
        </>
      )}
      {shown.length > 0 && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {shown.map(({ id, title, plugin, Panel }) => (
            <section
              key={id}
              aria-label={title}
              className={cn(cardClass, "flex min-w-0 flex-col gap-2.5 p-4")}
            >
              <h2 className="text-prose font-semibold text-fg-strong">
                {title}
              </h2>
              <PluginBoundary name={plugin}>
                <Panel context={pluginContext(plugin)} />
              </PluginBoundary>
            </section>
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

export function TeamSessions({
  sessions,
}: {
  readonly sessions: readonly Session[];
}): ReactElement {
  return (
    <Page>
      <PageTitle description="Every Session the team has, newest first. Anyone on the team can open one.">
        Sessions
      </PageTitle>
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
