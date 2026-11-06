import { piTerminal } from "@pipoca/protocol";
import type { EmbeddedSessionProps } from "@pipoca/plugins/web";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { request } from "../data/client";
import { invalidate, useMe, useQuery } from "../data/hooks";
import { shortName } from "../names";
import { PrimaryView } from "../primary";
import { href, navigate } from "../router";
import { ChatView } from "./chat/chat-view";
import { Composer, type Replying } from "./composer/composer";
import { prefillComposer } from "./composer/prefill";
import { emptyFeed, type Feed, feedReader, followEvents } from "./feed";
import { Header } from "./header";
import { MoveDialog } from "./move-team";
import { usePluginHeaders } from "./plugin-parts";
import { PresenceLine, usePresence, useTyping } from "./presence";
import { SessionActions } from "./session-actions";
import { sessionChannel } from "./session-channel";
import { PagesNotice, PiViewNotice, UiActionNotice } from "./session-notices";
import { AccessDialog, steers } from "./team-access";
import { TerminalScreen, TerminalView } from "./terminal/terminal-view";
import type { View } from "./view-switch";

export function SessionView({
  sessionId,
  onMenu,
  layout = "full",
  title: shownTitle,
  crumb,
  actions,
}: {
  readonly sessionId: string;
  readonly onMenu?: () => void;
} & Omit<EmbeddedSessionProps, "sessionId" | "layout"> &
  Partial<Pick<EmbeddedSessionProps, "layout">>): ReactElement {
  const primary = layout === "full";
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [view, setView] = useState<View>("chat");
  const [limiting, setLimiting] = useState(false);
  const [moving, setMoving] = useState(false);
  const { user, admin, team: hasTeam } = useMe();
  const me = { id: user.id, admin, team: hasTeam };
  const environments = useQuery("environments.list").data ?? [];
  const report = useRef<(error: unknown) => void>(() => undefined);
  const [channel] = useState(() => sessionChannel(sessionId));

  const sessionChanged = useEffectEvent(() => {
    invalidate(["sessions"]);
  });

  const reportError = useCallback((error: unknown) => {
    report.current(error);
  }, []);

  useEffect(() => {
    const reader = feedReader({
      dispatch: channel.dispatch,
      onChange: setFeed,
      onSession: () => {
        sessionChanged();
      },
    });

    report.current = reader.report;

    return followEvents(sessionId, reader, (url) => new EventSource(url));
  }, [sessionId, channel]);

  const { session } = feed;

  const environment = environments.find(
    ({ id }) => id === session?.environmentId,
  );

  const place = session ? shortName(session.workspace) : "";
  const named = feed.title ?? session?.title ?? undefined;
  const title = shownTitle ?? named ?? place;

  const archived = session !== undefined && session.archivedAt !== null;
  const watching = session !== undefined && !steers(session, me);

  const team = session?.ownedBy === "team";
  const present = usePresence(sessionId, team);
  const typed = useTyping(sessionId, team);
  const [replying, setReplying] = useState<Replying>();
  const teammates = useQuery("people.list").data ?? [];

  const limits =
    session?.ownedBy === "team" && (me.admin || session.startedBy === me.id);

  // Team work opens inside the team's area, whichever link led to it.
  useEffect(() => {
    if (
      primary &&
      team &&
      location.hash === href("session", { id: sessionId })
    ) {
      navigate(href("teamSession", { id: sessionId }), { replace: true });
    }
  }, [primary, team, sessionId]);

  const shown = archived ? "chat" : view;

  const pageTitle = shownTitle ?? named;

  useEffect(() => {
    if (!primary) {
      return undefined;
    }

    document.title =
      pageTitle === undefined ? "Pipoca" : `${pageTitle} · Pipoca`;

    return () => {
      document.title = "Pipoca";
    };
  }, [pageTitle, primary]);

  const pluginHeaders = usePluginHeaders(team, channel.session);

  // The fork starts from this Session's branch, so it gets what was pushed
  // or, on the same machine, committed. From a message, that message comes
  // back in the fork's composer.
  const forkSession = async (
    entry?: string,
    personal = false,
    draft = "",
  ): Promise<void> => {
    try {
      const fork = await request("sessions.create", {
        body: {
          from: { session: sessionId, ...(entry !== undefined && { entry }) },
          ...(personal && { personal }),
        },
      });

      const editorText = fork.editorText ?? draft;

      if (editorText !== "") {
        prefillComposer(fork.id, editorText);
      }

      navigate(
        href(team && !personal ? "teamSession" : "session", { id: fork.id }),
      );
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <PrimaryView value={primary}>
      <section
        id={primary ? "session" : undefined}
        aria-label={title}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <Header
          primary={primary}
          shown={shown}
          feed={feed}
          title={title}
          crumb={crumb}
          environments={environments}
          pluginHeaders={pluginHeaders}
          archived={archived}
          view={view}
          onView={setView}
          onMenu={onMenu}
          actions={actions}
          menu={
            session && (
              <SessionActions
                session={session}
                feed={feed}
                team={team}
                hasTeam={me.team}
                limits={limits}
                archived={archived}
                report={reportError}
                onFork={(entry, personal) => {
                  void forkSession(entry, personal);
                }}
                onLimit={() => {
                  setLimiting(true);
                }}
                onMove={() => {
                  setMoving(true);
                }}
              />
            )
          }
        />

        {shown === "terminal" && (
          <TerminalView sessionId={sessionId} terminals={feed.terminals} />
        )}
        {shown === "pi" && (
          <TerminalScreen
            sessionId={sessionId}
            terminalId={piTerminal}
            onClosed={() => {
              setView("chat");
            }}
          />
        )}
        <div
          hidden={shown !== "chat"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ChatView
            feed={feed}
            place={place}
            hidden={shown !== "chat"}
            session={channel.session}
            {...(team &&
              !watching &&
              !archived && {
                onReply: (quote) => {
                  setReplying({
                    quote,
                    by:
                      quote.from === "pi"
                        ? "Pi"
                        : (teammates.find(({ id }) => id === quote.from)
                            ?.name ?? "Someone"),
                  });
                },
              })}
          />
          {!archived && (
            <PagesNotice
              sessionId={sessionId}
              pages={feed.pages}
              report={reportError}
            />
          )}
          <UiActionNotice
            uiAction={archived ? undefined : feed.uiAction}
            goes={primary && shown === "chat"}
          />
          {!archived && (
            <PiViewNotice
              piView={feed.piView}
              onOpen={() => {
                setView("pi");
              }}
            />
          )}
          {!archived && <PresenceLine people={present} me={me.id} />}
          <div onInput={typed} className="contents">
            <Composer
              sessionId={sessionId}
              session={channel.session}
              feed={feed}
              models={environment?.models ?? []}
              hiddenModels={environment?.hiddenModels ?? []}
              hidden={archived || watching}
              report={reportError}
              team={team}
              replying={replying}
              onReplied={() => {
                setReplying(undefined);
              }}
              onFork={(draft) => {
                void forkSession(undefined, false, draft);
              }}
            />
          </div>
          {watching && !archived && (
            <p
              role="status"
              className="mx-auto w-full max-w-chat px-4 pb-4 text-label text-fg-dim"
            >
              This team work is view-only. You can follow along while whoever
              started it steers.
            </p>
          )}
        </div>
        {session && limits && (
          <AccessDialog
            session={session}
            open={limiting}
            onClose={() => {
              setLimiting(false);
            }}
          />
        )}
        {session && !team && (
          <MoveDialog
            session={session}
            items={feed.items}
            busy={
              session.status === "running" ||
              session.status === "starting" ||
              session.status === "queued"
            }
            open={moving}
            onClose={() => {
              setMoving(false);
            }}
          />
        )}
      </section>
    </PrimaryView>
  );
}
