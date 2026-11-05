import { apiPath, type Profile } from "@pipoca/protocol";
import {
  Badge,
  Icon,
  initialsOf,
  Page,
  PageTitle,
  Row,
  Rows,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../../api";
import { messageOf } from "./upload";
import { ProfileOverview, profilesPath } from "./overview";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";
import {
  layerHashes,
  type Layer,
  layerRoutes,
  layerNames,
  chipClass,
} from "./layers";
import { Editor } from "./editor";
import { ProfileTabs } from "./tabs";
import { BuildsOn, LayerEditor } from "./builds-on";
import { Synced } from "./synced";
import { Import } from "./import";

// A person's Profiles in Settings, or with team the team's in Team setup.
export function ProfilesPage({
  profiles,
  admin,
  team = false,
  selected,
  onChange,
}: {
  readonly profiles: readonly Profile[];
  readonly admin: boolean;
  readonly team?: boolean;
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const [id = "", tab = "overview"] = selected.split("/");
  const profile = profiles.find((each) => each.id === id);
  const root = profilesPath(team);

  const layer = team
    ? undefined
    : (Object.keys(layerHashes) as Layer[]).find(
        (each) => layerHashes[each] === id,
      );

  // The editor starts again when its files change, so it doesn't keep this.
  const [savedId, setSavedId] = useState<string>();

  return (
    <Page id="profiles-page">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          {team ? (
            <PageTitle description="The team owns these. Everyone can pick them for team work, and only admins change them. They build on the Server base and never load anyone's My defaults.">
              Team Profiles
            </PageTitle>
          ) : (
            <PageTitle description="How Pi behaves in a Session: what it knows, the skills and tools it has. A Profile is a Pi agent folder, like your ~/.pi/agent. Every Profile sits on the Server base and your My defaults. Edits reach a Session the next time it starts.">
              Profiles
            </PageTitle>
          )}
        </div>
        <a
          href={`#${root}/new`}
          aria-current={selected === "new" ? "page" : undefined}
          className="mt-7 inline-flex h-control shrink-0 items-center gap-1.5 rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:border-line-strong hover:bg-hover"
        >
          <Icon name="plus" />
          {team ? "New team Profile" : "New Profile"}
        </a>
      </div>
      {(!team || selected !== "") && (
        <nav aria-label="Profiles" className="flex flex-wrap gap-2">
          {profiles.map((each) => (
            <a
              key={each.id}
              href={`#${root}/${each.id}`}
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
                href={`#profiles/${layerHashes[each]}`}
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
                  api("profiles.update", {
                    params: { id: profile.id },
                    body: { buildsOn },
                  }).then(onChange, (reason: unknown) => {
                    alert(messageOf(reason));
                  });
                }}
              />
            </span>
          )}
        </nav>
      )}
      {profile && (
        <ProfileTabs
          url={apiPath("profiles.files", { params: { id: profile.id } })}
          hash={`${root}/${profile.id}`}
          tab={tab}
          overview={
            <>
              {profile.source && (
                <Synced
                  profile={profile}
                  source={profile.source}
                  onChange={onChange}
                />
              )}
              <ProfileOverview
                profile={profile}
                profiles={profiles}
                editable={profile.source === null}
                onChange={onChange}
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
                onChange={onChange}
              />
            </>
          }
        />
      )}
      {layer && (
        <ProfileTabs
          key={layer}
          url={apiPath(`${layerRoutes[layer]}.files`)}
          hash={`profiles/${layerHashes[layer]}`}
          tab={tab}
          overview={<LayerEditor layer={layer} />}
        />
      )}
      {selected === "new" && (
        <Editor key="new" profiles={profiles} team={team} onChange={onChange} />
      )}
      {selected === "" && !team && <Import onChange={onChange} />}
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
                href={`#${root}/${each.id}`}
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
