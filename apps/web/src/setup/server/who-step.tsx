import type { ServerUse } from "@pipoca/protocol";
import { ChoiceCard, Notice } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { seed, useQuery } from "../../data/hooks";
import { StepFooter } from "../footer";

const choices: readonly {
  readonly value: ServerUse;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    value: "me",
    title: "Just me",
    description:
      "One setup: your code hosts, models and Profile. Nothing to share or invite.",
  },
  {
    value: "team",
    title: "A team",
    description:
      "First what the server shares: plugins, sign-in, code hosts, shared model keys, team Profiles, where Sessions run, what new people get. Then your own setup, like everyone else's.",
  },
];

// The first question of the server's setup (ADR 0072). A team is
// preselected until an admin answers.
export function WhoStep(): ReactElement {
  const saved = useQuery("settings.serverSetup").data?.usedBy ?? null;
  const [picked, setPicked] = useState<ServerUse>();
  const usedBy = picked ?? saved ?? "team";

  return (
    <>
      <ul
        role="radiogroup"
        aria-label="Who uses this server"
        className="flex flex-col gap-2.5"
      >
        {choices.map(({ value, title, description }) => (
          <ChoiceCard
            key={value}
            as="li"
            name="used-by"
            title={title}
            description={description}
            checked={usedBy === value}
            onChange={() => {
              setPicked(value);
            }}
          />
        ))}
      </ul>
      <Notice>
        You&apos;re this server&apos;s admin, so its setup link has stopped
        working. What you pick here you can change later in Settings.
      </Notice>
      <StepFooter
        answer={async () => {
          seed(
            "settings.serverSetup",
            await request("settings.serverSetup.update", { body: { usedBy } }),
          );
        }}
      />
    </>
  );
}
