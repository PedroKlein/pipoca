import { teamMessagesRead } from "@pipoca/protocol";
import { Button, Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useQuery } from "../../data/hooks";

// What Pi reads of the team's talk with the next message, and past what it
// reads, a fork that starts fresh instead (ADR 0065).
export function TeamTalk({
  unread,
  onFork,
}: {
  readonly unread: number;
  readonly onFork: (() => void) | undefined;
}): ReactElement | null {
  const messagesRead =
    useQuery("settings.team").data?.messagesRead ?? teamMessagesRead;

  if (unread === 0) {
    return null;
  }

  if (unread <= messagesRead) {
    return (
      <p className="text-label text-fg-dim">
        Pi also reads the{" "}
        {unread === 1 ? "team message" : `${String(unread)} team messages`}{" "}
        since its last turn.
      </p>
    );
  }

  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-fg-dim"
    >
      <span className="min-w-0 flex-1">
        Pi reads only the latest {messagesRead} of {unread} team messages since
        its last turn. Fork to start fresh, and tell Pi where the team landed.
      </span>
      {onFork && (
        <Button variant="ghost" onClick={onFork}>
          <Icon name="git-fork" />
          Fork
        </Button>
      )}
    </p>
  );
}
