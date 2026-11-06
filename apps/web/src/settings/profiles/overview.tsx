import { json } from "../../responses";
import { useLoaded } from "@pipoca/plugins/web";
import { apiPath, type Profile } from "@pipoca/protocol";
import { ErrorText, initialsOf, Row, Rows, Section } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { api } from "../../api";
import { messageOf } from "./upload";
import {
  type Skill,
  type Below,
  Instructions,
  SystemPromptCard,
  Skills,
  AddLink,
} from "./overview-parts";
import { Packages } from "./packages";
import {
  skillsIn,
  offSkills,
  withSkill,
  chainOf,
  serverOf,
} from "./overview-values";

// Where Profiles open: the team's in Team setup, which never load anyone's
// My defaults (ADR 0064).
export function profilesPath(team: boolean): string {
  return team ? "team/setup/profiles" : "profiles";
}

// A Profile at a glance, as the mockups lay it out (ADR 0063). Each card
// opens its tab to edit the files behind it.
export function ProfileOverview({
  profile,
  profiles,
  editable,
  onChange,
  children,
}: {
  readonly profile: Profile;
  readonly profiles: readonly Profile[];
  readonly editable: boolean;
  readonly onChange: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const url = apiPath("profiles.files", { params: { id: profile.id } });

  const tab = (name: string): string =>
    `#${profilesPath(profile.ownerId === "team")}/${profile.id}/${name}`;

  const below: readonly Below[] = [
    ...chainOf(profile, profiles).map(({ id, name }) => ({
      name,
      url: apiPath("profiles.files", { params: { id } }),
    })),
    ...(profile.ownerId === "team"
      ? []
      : [{ name: "My defaults", url: apiPath("me.profileDefaults.files") }]),
    { name: "Server base", url: apiPath("settings.baseProfile.files") },
  ];

  const { value: files } = useLoaded(
    async () => {
      const [own, ...layers] = await Promise.all(
        [{ name: "", url }, ...below].map(async (layer) =>
          skillsIn(layer.url, layer.name === "" ? undefined : layer.name),
        ),
      );

      const skills = [own ?? [], ...layers].reduce<readonly Skill[]>(
        (found, layer) => [
          ...found,
          ...layer.filter(
            ({ folder }) => !found.some((skill) => skill.folder === folder),
          ),
        ],
        [],
      );

      const entries = await json<{ readonly path: string }[]>(fetch(url));

      const prompts = entries.flatMap(({ path }) => {
        const name = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

        return name === undefined ? [] : [name];
      });

      return { skills, prompts };
    },
    `${url}:${below.map(({ url: each }) => each).join(",")}`,
    { topics: ["profiles"] },
  );

  const [error, setError] = useState<string>();

  const save = (body: Partial<Profile>): void => {
    api("profiles.update", { params: { id: profile.id }, body }).then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <>
      <ErrorText size="caption" className="mt-4">
        {error}
      </ErrorText>
      <Instructions text={profile.agentsMd} edit={tab("instructions")} />
      <SystemPromptCard
        key={`${profile.systemMd}:${profile.appendSystemMd}`}
        profile={profile}
        editable={editable}
        onSave={save}
      />
      <Skills
        skills={files?.skills}
        off={offSkills(profile.settings)}
        editable={editable}
        add={tab("skills")}
        onToggle={(folder, on) => {
          save({ settings: withSkill(profile.settings, folder, on) });
        }}
      />
      <Packages
        packages={profile.packages}
        editable={editable}
        onSave={(packages) => {
          save({ packages });
        }}
      />
      <Section
        title="MCP servers"
        actions={editable && <AddLink href={tab("mcp")} label="Add server" />}
      >
        {Object.keys(profile.mcpServers).length > 0 && (
          <Rows label="MCP servers">
            {Object.entries(profile.mcpServers).map(([name, config]) => (
              <Row
                key={name}
                initials={initialsOf(name)}
                title={name}
                description={
                  <span className="font-mono">{serverOf(config)}</span>
                }
              />
            ))}
          </Rows>
        )}
      </Section>
      {children}
      <Section title="Prompts" description="Slash commands in the composer">
        <ul aria-label="Prompts" className="flex flex-wrap gap-1.5">
          {files?.prompts.map((name) => (
            <li
              key={name}
              className="rounded-full border border-line bg-elevated px-3 py-1 font-mono text-mono-sm"
            >
              /{name}
            </li>
          ))}
          {editable && (
            <li>
              <a
                href={tab("prompts")}
                className="inline-flex rounded-full border border-dashed border-line-strong px-3 py-1 text-label text-fg-dim hover:text-fg"
              >
                Add prompt
              </a>
            </li>
          )}
        </ul>
      </Section>
    </>
  );
}
