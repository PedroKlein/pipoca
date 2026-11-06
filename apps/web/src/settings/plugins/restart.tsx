import { ApiError, type PluginInfo } from "@pipoca/protocol";
import { Button, Card, ErrorText, plural, useConfirm } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";

// A failed plugin shows its error instead.
export function switchesAtRestart(plugin: PluginInfo): boolean {
  return (
    plugin.source === "installed" &&
    plugin.state !== "failed" &&
    plugin.turnedOn !== (plugin.state === "on")
  );
}

export function waitsForRestart(plugin: PluginInfo): boolean {
  return (
    switchesAtRestart(plugin) ||
    (plugin.source === "installed" &&
      plugin.updated === true &&
      plugin.turnedOn)
  );
}

// Sessions on the server's own runner stop with it, so a restart asks first
// while one is mid-turn (ADR 0022). The page reloads once the server answers
// again.
export function Restart(): ReactElement {
  const [state, setState] = useState<"idle" | "restarting">("idle");
  const [ask, asking] = useConfirm();

  const restart = async (force: boolean): Promise<void> => {
    const before = await startedAt();

    const refused = await request("server.restart", { body: { force } }).then(
      () => undefined,
      (reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 409) {
          return reason;
        }

        throw reason;
      },
    );

    if (refused) {
      const { sessions } = refused.body as { readonly sessions: number };

      if (
        await ask({
          title: "Restart anyway?",
          description: `${plural(sessions, "Session is", "Sessions are")} mid-turn on the server's own runner and will be interrupted.`,
          confirm: "Restart",
          danger: true,
        })
      ) {
        await restart(true);
      }

      return;
    }

    setState("restarting");
    await back(before);
    location.reload();
  };

  const now = useAction(restart);

  return (
    <Card
      padding="none"
      className="mb-4 flex flex-wrap items-center gap-3 p-4 text-ui"
    >
      <span className="text-fg">
        {state === "restarting"
          ? "Restarting the server…"
          : "Some changes wait for the server to restart."}
      </span>
      {state === "idle" && (
        <Button
          onClick={() => {
            void now.run(false);
          }}
        >
          Restart now
        </Button>
      )}
      <ErrorText size="caption">{now.error}</ErrorText>
      {asking}
    </Card>
  );
}

// The old server keeps answering while it stops its Sessions, so this waits
// for one that started later.
async function back(before: string | undefined): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const now = await startedAt();

    if (now !== undefined && now !== before) {
      return;
    }
  }
}

async function startedAt(): Promise<string | undefined> {
  return request("health").then(
    ({ started }) => started,
    () => undefined,
  );
}
