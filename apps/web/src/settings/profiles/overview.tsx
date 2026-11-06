import type { Profile } from "@pipoca/protocol";
import { Chip, ErrorText, initialsOf, Row, Rows, Section } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { request } from "../../data/client";
import { useAction, useLoad } from "../../data/hooks";
import { scopedHref } from "../../router";
import { type Folder, layerFolder, profileFolder } from "./folder";
import {
  type Skill,
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

// A Profile at a glance, as the mockups lay it out (ADR 0063). Each card
// opens its tab to edit the files behind it.
export function ProfileOverview({
  profile,
  profiles,
  editable,
  children,
}: {
  readonly profile: Profile;
  readonly profiles: readonly Profile[];
  readonly editable: boolean;
  readonly children?: ReactNode;
}): ReactElement {
  const own = profileFolder(profile.id);

  const tab = (name: string): string =>
    scopedHref(profile.ownerId === "team", "profiles", `${profile.id}/${name}`);

  const below: readonly { readonly name: string; readonly folder: Folder }[] = [
    ...chainOf(profile, profiles).map(({ id, name }) => ({
      name,
      folder: profileFolder(id),
    })),
    ...(profile.ownerId === "team"
      ? []
      : [{ name: "My defaults", folder: layerFolder("defaults") }]),
    { name: "Server base", folder: layerFolder("base") },
  ];

  const files = useLoad(
    `${own.key} overview ${below.map(({ folder }) => folder.key).join(",")}`,
    async () => {
      const [mine, ...layers] = await Promise.all([
        skillsIn(own),
        ...below.map(async (layer) => skillsIn(layer.folder, layer.name)),
      ]);

      const skills = [mine, ...layers].reduce<readonly Skill[]>(
        (found, layer) => [
          ...found,
          ...layer.filter(
            ({ folder }) => !found.some((skill) => skill.folder === folder),
          ),
        ],
        [],
      );

      const entries = await own.list();

      const prompts = entries.flatMap(({ path }) => {
        const name = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

        return name === undefined ? [] : [name];
      });

      return { skills, prompts };
    },
    { topics: ["profiles"] },
  ).data;

  const update = useAction(async (body: Partial<Profile>) =>
    request("profiles.update", { params: { id: profile.id }, body }),
  );

  const save = (body: Partial<Profile>): void => {
    void update.run(body);
  };

  const error = update.error;

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
            <li key={name}>
              <Chip mono>/{name}</Chip>
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
