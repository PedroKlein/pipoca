import {
  Badge,
  buttonClass,
  ErrorText,
  Icon,
  initialsOf,
  Page,
  Row,
  Rows,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useAction, useMe, useQuery } from "../../data/hooks";
import { href, scopedHref } from "../../router";
import { layerFolder, profileFolder } from "./folder";
import { ProfileOverview } from "./overview";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";
import { layerHashes, type Layer, layerNames, chipClass } from "./layers";
import { Editor } from "./editor";
import { ProfileTabs } from "./tabs";
import { BuildsOn, LayerEditor } from "./builds-on";
import { Synced } from "./synced";
import { Import } from "./import";

// A person's Profiles in Settings, or with team the team's in Team setup.
export function ProfilesPage({
  team = false,
  selected,
}: {
  readonly team?: boolean;
  readonly selected: string;
}): ReactElement {
  const { admin } = useMe();

  const profiles =
    useQuery("profiles.list", team ? { query: { scope: "team" } } : undefined)
      .data ?? [];

  const [id = "", tab = "overview"] = selected.split("/");
  const profile = profiles.find((each) => each.id === id);
  const root = scopedHref(team, "profiles");

  const layer = team
    ? undefined
    : (Object.keys(layerHashes) as Layer[]).find(
        (each) => layerHashes[each] === id,
      );

  // The editor starts again when its files change, so it doesn't keep this.
  const [savedId, setSavedId] = useState<string>();

  const buildOn = useAction(
    async (profileId: string, buildsOn: string | null) =>
      request("profiles.update", {
        params: { id: profileId },
        body: { buildsOn },
      }),
  );

  return (
    <Page
      id="profiles-page"
      title={team ? "Team Profiles" : "Profiles"}
      description={
        team
          ? "The team owns these. Everyone can pick them for team work, and only admins change them. They build on the Server base and never load anyone's My defaults."
          : "How Pi behaves in a Session: what it knows, the skills and tools it has. A Profile is a Pi agent folder, like your ~/.pi/agent. Every Profile sits on the Server base and your My defaults. Edits reach a Session the next time it starts."
      }
      actions={
        <a
          href={`${root}/new`}
          aria-current={selected === "new" ? "page" : undefined}
          className={buttonClass({ variant: "primary" })}
        >
          <Icon name="plus" />
          {team ? "New team Profile" : "New Profile"}
        </a>
      }
    >
      {(!team || selected !== "") && (
        <nav aria-label="Profiles" className="flex flex-wrap gap-2">
          {profiles.map((each) => (
            <a
              key={each.id}
              href={`${root}/${each.id}`}
              aria-current={each.id === id ? "page" : undefined}
              className={chipClass}
            >
              {each.name}
              {each.isDefault && <Badge state="done">Default</Badge>}
              {each.ownerId === null && <Badge state="offline">Shared</Badge>}
              {each.source && <Badge state="offline">Synced</Badge>}
            </a>
          ))}
          {!team &&
            (Object.keys(layerHashes) as Layer[]).map((each) => (
              <a
                key={each}
                href={href("settings", {
                  page: "profiles",
                  rest: layerHashes[each],
                })}
                aria-current={id === layerHashes[each] ? "page" : undefined}
                className={chipClass}
              >
                {each === "base" && !admin && (
                  <Icon name="lock" className="size-3.5" />
                )}
                {layerNames[each]}
              </a>
            ))}
          {profile && (
            <span className="ml-auto">
              <BuildsOn
                profile={profile}
                profiles={profiles}
                value={profile.buildsOn}
                team={team}
                disabled={profile.source !== null}
                onChange={(buildsOn) => {
                  void buildOn.run(profile.id, buildsOn);
                }}
              />
            </span>
          )}
        </nav>
      )}
      <ErrorText size="caption">{buildOn.error}</ErrorText>
      {profile && (
        <ProfileTabs
          folder={profileFolder(profile.id)}
          base={`${root}/${profile.id}`}
          tab={tab}
          overview={
            <>
              {profile.source && (
                <Synced profile={profile} source={profile.source} />
              )}
              <ProfileOverview
                profile={profile}
                profiles={profiles}
                editable={profile.source === null}
              >
                {!team && <ProfileParts profileId={profile.id} />}
              </ProfileOverview>
              <Editor
                key={`${profile.id}:${JSON.stringify(profile.packages)}:${profile.buildsOn ?? ""}`}
                profile={profile}
                profiles={profiles}
                saved={savedId === profile.id}
                onSaved={() => {
                  setSavedId(profile.id);
                }}
              />
            </>
          }
        />
      )}
      {layer && (
        <ProfileTabs
          key={layer}
          folder={layerFolder(layer)}
          base={href("settings", {
            page: "profiles",
            rest: layerHashes[layer],
          })}
          tab={tab}
          overview={<LayerEditor layer={layer} />}
        />
      )}
      {selected === "new" && (
        <Editor key="new" profiles={profiles} team={team} />
      )}
      {selected === "" && !team && <Import />}
      {selected === "" && team && profiles.length > 0 && (
        <Rows label="Team Profiles">
          {profiles.map((each) => (
            <Row
              key={each.id}
              title={each.name}
              initials={initialsOf(each.name)}
              description={`Builds on ${profiles.find(({ id: under }) => under === each.buildsOn)?.name ?? "the Server base"}`}
            >
              <a
                href={`${root}/${each.id}`}
                className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:bg-hover"
              >
                Edit
              </a>
            </Row>
          ))}
        </Rows>
      )}
      {selected === "" && team && profiles.length === 0 && (
        <p className="rounded-lg border border-dashed border-line-strong p-5 text-ui text-fg-dim">
          No team Profile yet. Team work can't start until there is one.
        </p>
      )}
    </Page>
  );
}

// What plugins add to a Profile's page, such as its own logins (ADR 0063).
function ProfileParts({
  profileId,
}: {
  readonly profileId: string;
}): ReactElement {
  return (
    <>
      {enabledPlugins().map(({ name, settingsParts }) => {
        const Part = settingsParts?.Profile;

        return (
          Part && (
            <PluginBoundary key={name} name={name}>
              <Part context={pluginContext(name)} profileId={profileId} />
            </PluginBoundary>
          )
        );
      })}
    </>
  );
}
