import type { Environment } from "@pipoca/protocol";
import { Button, Command, ErrorText, useConfirm } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";

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
        <>
          <p className="text-fg-dim">
            Start an agent with this key. It is shown only now.
          </p>
          <Command label="Join command">
            {`PIPOCA_KEY=${madeKey} pipoca agent --server ${location.origin}`}
          </Command>
        </>
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
