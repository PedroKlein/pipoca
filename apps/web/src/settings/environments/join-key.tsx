import type { Environment } from "@pipoca/protocol";
import { Button, Command, ErrorText, useConfirm } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";
import { useReachFlags } from "./reach";

export function JoinKey({
  environment,
  madeKey,
  onKey,
}: {
  readonly environment: Environment;
  readonly madeKey: string | undefined;
  readonly onKey: (key: string) => void;
}): ReactElement {
  const [ask, asking] = useConfirm();

  const replace = useAction(async () => {
    if (
      environment.hasKey &&
      !(await ask({
        title: "Replace the key?",
        description:
          "Agents that joined with the current key will have to join again with the new one.",
        confirm: "Replace key",
      }))
    ) {
      return;
    }

    const { key } = await request("environments.keys.create", {
      params: { id: environment.id },
    });

    onKey(key);
  });

  return (
    <div className="mt-3 flex flex-col gap-2 text-ui">
      {madeKey === undefined ? (
        <p className="text-fg-dim">
          {environment.hasKey
            ? "Agents join with this Environment's key, which was shown when it was made."
            : "No agent can join until the Environment has a key."}
        </p>
      ) : (
        <JoinCommand joinKey={madeKey}>
          Start an agent with this key. It is shown only now.
        </JoinCommand>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            void replace.run();
          }}
        >
          {environment.hasKey ? "Replace key" : "Make key"}
        </Button>
        <ErrorText size="caption">{replace.error}</ErrorText>
      </div>
      {asking}
    </div>
  );
}

// The command that joins a machine with a key shown once, with the private
// hosts it should say it reaches.
export function JoinCommand({
  joinKey,
  children,
}: {
  readonly joinKey: string;
  // What to do with it, such as where to run it.
  readonly children: ReactNode;
}): ReactElement {
  const [reach, reachPicker] = useReachFlags();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-fg-dim">{children}</p>
      {reachPicker}
      <Command label="Join command">
        {`PIPOCA_KEY=${joinKey} pipoca agent --server ${location.origin}${reach}`}
      </Command>
    </div>
  );
}
