import type { Profile } from "@pipoca/protocol";
import { ChoiceCard, ErrorText } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import { useNewcomers } from "../settings/people/newcomers";
import { ProfileStep } from "./profile-step";

export function ProfileStepPage(): ReactElement {
  const profiles = useQuery("profiles.list").data ?? [];

  const offered = useNewcomers().profiles.flatMap(
    (id) => profiles.find((profile) => profile.id === id) ?? [],
  );

  return (
    <>
      {offered.length > 0 && (
        <OfferedProfiles offered={offered} profiles={profiles} />
      )}
      <ProfileStep profiles={profiles} />
    </>
  );
}

// The shared Profiles an admin offers new people. Each one picked becomes a
// Profile of theirs that builds on it (ADR 0063).
function OfferedProfiles({
  offered,
  profiles,
}: {
  readonly offered: readonly Profile[];
  readonly profiles: readonly Profile[];
}): ReactElement {
  const pick = useAction(async (shared: Profile, mine: Profile | undefined) => {
    await (mine === undefined
      ? request("profiles.create", {
          body: { name: shared.name, buildsOn: shared.id },
        })
      : request("profiles.remove", { params: { id: mine.id } }));
  });

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
                void pick.run(shared, checked ? undefined : mine);
              }}
            />
          );
        })}
      </ul>
      <ErrorText size="caption">{pick.error}</ErrorText>
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
