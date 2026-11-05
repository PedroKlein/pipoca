import type { Profile } from "@pipoca/protocol";
import { ChoiceCard, ErrorText } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../api";
import { useProfiles } from "../hooks";
import { useNewcomers } from "../settings/people/newcomers";
import { ProfileStep } from "./profile-step";

export function ProfileStepPage(): ReactElement {
  const profiles = useProfiles();

  const offered = useNewcomers().value.profiles.flatMap(
    (id) => profiles.value.find((profile) => profile.id === id) ?? [],
  );

  return (
    <>
      {offered.length > 0 && (
        <OfferedProfiles
          offered={offered}
          profiles={profiles.value}
          onChange={profiles.reload}
        />
      )}
      <ProfileStep profiles={profiles.value} onImported={profiles.reload} />
    </>
  );
}

// The shared Profiles an admin offers new people. Each one picked becomes a
// Profile of theirs that builds on it (ADR 0063).
function OfferedProfiles({
  offered,
  profiles,
  onChange,
}: {
  readonly offered: readonly Profile[];
  readonly profiles: readonly Profile[];
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-label text-fg-dim">
        Pick any. Each one becomes a Profile of yours, and you can switch per
        Session.
      </p>
      <ul aria-label="Profiles on offer" className="flex flex-col gap-2.5">
        {offered.map((shared) => {
          const mine = profiles.find(
            ({ ownerId, buildsOn }) =>
              ownerId !== null && buildsOn === shared.id,
          );

          return (
            <ChoiceCard
              type="checkbox"
              as="li"
              key={shared.id}
              title={shared.name}
              description={offeredDescription(shared)}
              checked={mine !== undefined}
              onChange={(checked) => {
                const change =
                  checked || mine === undefined
                    ? api("profiles.create", {
                        body: { name: shared.name, buildsOn: shared.id },
                      })
                    : api("profiles.remove", { params: { id: mine.id } });

                change.then(onChange, failed);
              }}
            />
          );
        })}
      </ul>
      <ErrorText size="caption">{error}</ErrorText>
      <p className="pt-2 text-label font-medium text-fg">Or bring your own</p>
    </div>
  );
}

function offeredDescription(profile: Profile): string {
  const first = profile.agentsMd
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "");

  return first ?? "A Profile your team shares";
}
