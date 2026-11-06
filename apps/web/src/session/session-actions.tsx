import { movable, type Session } from "@pipoca/protocol";
import {
  type IconName,
  Menu,
  Picker,
  type PickerOption,
  useConfirm,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { request } from "../data/client";
import { ago } from "./chat/chat";
import type { Feed } from "./feed";

export function SessionActions({
  session,
  feed,
  team,
  hasTeam,
  limits,
  archived,
  report,
  onFork,
  onLimit,
  onMove,
}: {
  readonly session: Session;
  readonly feed: Feed;
  readonly team: boolean;
  readonly hasTeam: boolean;
  readonly limits: boolean;
  readonly archived: boolean;
  readonly report: (error: unknown) => void;
  readonly onFork: (entry?: string, personal?: boolean) => void;
  readonly onLimit: () => void;
  readonly onMove: () => void;
}): ReactElement {
  const forkMenu = useRef<HTMLButtonElement>(null);
  const [forkedAt, setForkedAt] = useState(0);
  const [ask, asking] = useConfirm();

  const archive = (to: boolean): void => {
    request("sessions.update", {
      params: { id: session.id },
      body: { archived: to },
    }).catch(report);
  };

  const removeWorkspace = (): void => {
    request("sessions.workspace.remove", { params: { id: session.id } }).catch(
      report,
    );
  };

  return (
    <>
      <SessionMenu
        popover={
          <ForkPicker
            feed={feed}
            now={forkedAt}
            trigger={forkMenu}
            onFork={(entry) => {
              onFork(entry);
            }}
          />
        }
        items={[
          archived
            ? {
                label: "Unarchive",
                icon: "archive",
                run: () => {
                  archive(false);
                },
              }
            : {
                label: "Archive",
                icon: "archive",
                run: () => {
                  archive(true);
                },
              },
          ...(limits
            ? [
                {
                  label: "Who steers",
                  icon: "users",
                  run: onLimit,
                } as const,
              ]
            : []),
          {
            label: "Fork",
            icon: "git-fork",
            run: () => {
              setForkedAt(Date.now());
              forkMenu.current?.click();
            },
          },
          ...(team
            ? [
                {
                  label: "Fork to my own work",
                  icon: "git-fork",
                  run: () => {
                    onFork(undefined, true);
                  },
                } as const,
              ]
            : []),
          ...(!team && hasTeam && !archived && movable(session.workspace)
            ? [
                {
                  label: "Move to the team",
                  icon: "users",
                  run: onMove,
                } as const,
              ]
            : []),
          ...(session.workspaceRemoval === "kept"
            ? [
                {
                  label: "Delete workspace",
                  icon: "trash",
                  danger: true,
                  run: () => {
                    void ask({
                      title: "Delete the workspace for good?",
                      description: `It was kept: ${session.workspaceKeptReason ?? "unpushed work"}.`,
                      confirm: "Delete workspace",
                      danger: true,
                    }).then((yes) => {
                      if (yes) {
                        removeWorkspace();
                      }
                    });
                  },
                } as const,
              ]
            : []),
        ]}
      />
      {asking}
    </>
  );
}

// Pi's /fork: the user messages to start a new Session from, newest first.
// The whole Session is Pi's /clone. The Fork menu item opens it in the
// menu's place.
function ForkPicker({
  feed,
  now,
  trigger,
  onFork,
}: {
  readonly feed: Feed;
  readonly now: number;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly onFork: (entry?: string) => void;
}): ReactElement {
  const options = feed.items
    .flatMap((item): PickerOption[] =>
      item.role === "user" && item.entryId !== undefined
        ? [
            {
              value: item.entryId,
              label:
                item.text
                  .split("\n")
                  .find((line) => line.trim() !== "")
                  ?.trim() ?? "Image",
              ...(item.at !== undefined && { detail: ago(item.at, now) }),
            },
          ]
        : [],
    )
    .reverse();

  return (
    <Picker
      label="Fork from a message"
      placeholder="Search messages"
      chip={false}
      trigger={trigger}
      options={options}
      selected={[]}
      actions={[
        {
          label: "Fork the whole Session",
          run: () => {
            onFork();
          },
        },
      ]}
      onChange={([entry]) => {
        onFork(entry);
      }}
    >
      Fork from a message
    </Picker>
  );
}

interface MenuItem {
  readonly label: string;
  readonly icon: IconName;
  readonly danger?: boolean;
  readonly run: () => void;
}

function SessionMenu({
  items,
  popover,
}: {
  readonly items: readonly MenuItem[];
  // A list an item opens where the menu was.
  readonly popover?: ReactNode;
}): ReactElement {
  return (
    <div className="relative">
      <div className="absolute top-full right-0">{popover}</div>
      <Menu label="Session actions" items={items} />
    </div>
  );
}
