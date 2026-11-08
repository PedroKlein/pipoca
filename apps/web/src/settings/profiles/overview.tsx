import type { ProfileContent } from "@pipoca/protocol";
import {
  Chip,
  ErrorText,
  initialsOf,
  Row,
  Rows,
  Section,
  Segmented,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { useAction, useLoad } from "../../data/hooks";
import type { Folder } from "./folder";
import { firstLine, InheritedRow, SourceTag } from "./inherited";
import {
  type Skill,
  Instructions,
  SystemPromptCard,
  Skills,
  AddLink,
} from "./overview-parts";
import { agentsIn, builtinAgents, workflowsIn } from "./agent-files";
import { Agents, type ItemsLayer, Workflows } from "./agents";
import { Packages, nameOf } from "./packages";
import { PreviewButton } from "./preview";
import { skillsIn, offSkills, withSkill, serverOf } from "./overview-values";
import {
  copyInto,
  inherited,
  itemsOf,
  sourceOf,
  type StackLayer,
  withOff,
} from "./stack";

// A layer's page: a Profile, My defaults or the Server base.
export interface OverviewTarget {
  readonly id: string;
  readonly name: string;
  readonly folder: Folder;
  readonly content: ProfileContent;
  readonly editable: boolean;
  // The link to one of its tabs, such as Skills.
  readonly tab: (name: string) => string;
  readonly save: (body: Partial<ProfileContent>) => Promise<unknown>;
  // Offers the folder a runner gets, for a Profile.
  readonly preview?: boolean;
}

export type BelowLayer = Omit<StackLayer, "paths">;

// A layer at a glance, with everything it gets from the layers below it
// (ADR 0074). Each card opens its tab to edit the files behind it.
export function ProfileOverview({
  target,
  below,
  children,
}: {
  readonly target: OverviewTarget;
  // The layers under it, the Server base first.
  readonly below: readonly BelowLayer[];
  readonly children?: ReactNode;
}): ReactElement {
  const { content, editable, name } = target;
  const [onlyOwn, setOnlyOwn] = useState(false);

  const loaded = useLoad(
    `${target.folder.key} overview ${below.map(({ folder }) => folder.key).join(",")}`,
    async () => {
      const layers = await Promise.all(
        [...below.map(({ folder }) => folder), target.folder].map(
          async (folder) => {
            const paths = (await folder.list().catch(() => [])).map(
              ({ path }) => path,
            );

            return {
              paths,
              skills: await skillsIn(folder),
              agents: await agentsIn(folder, paths),
              workflows: await workflowsIn(folder, paths),
            };
          },
        ),
      );

      return layers;
    },
    { topics: ["profiles"] },
  ).data;

  const update = useAction(async (body: Partial<ProfileContent>) =>
    target.save(body),
  );

  const save = (body: Partial<ProfileContent>): void => {
    void update.run(body);
  };

  const copying = useAction(async (from: StackLayer, key: string) =>
    copyInto(from.folder, target.folder, key),
  );

  const toggle = (key: string, on: boolean): void => {
    save({ off: withOff(content.off, key, on) });
  };

  const stack: readonly StackLayer[] = below.map((layer, index) => ({
    ...layer,
    paths: loaded?.[index]?.paths ?? [],
  }));

  const own: StackLayer = {
    id: target.id,
    name,
    kind: "profile",
    folder: target.folder,
    content,
    paths: loaded?.at(-1)?.paths ?? [],
  };

  const skillsOf = (layer: StackLayer): readonly (readonly [string, Skill])[] =>
    (loaded?.[stack.indexOf(layer)]?.skills ?? []).map(
      (skill) => [skill.folder, skill] as const,
    );

  const layerOf = (layer: StackLayer) => loaded?.[stack.indexOf(layer)];

  const shown = <T,>(entries: readonly T[]): readonly T[] =>
    onlyOwn ? [] : entries;

  const agents = shown(inherited(stack, own, itemsOf.agents));
  const append = shown(inherited(stack, own, itemsOf.append));

  const ownPackages = new Set(content.packages.map(sourceOf));

  const packages = shown(
    inherited(stack, own, itemsOf.packages).filter(
      ({ item }) => !ownPackages.has(sourceOf(item)),
    ),
  );

  const mcp = shown(
    inherited(stack, own, itemsOf.mcp).filter(
      ({ item }) => !(item.name in content.mcpServers),
    ),
  );

  const prompts = shown(inherited(stack, own, itemsOf.prompts));
  const skills = shown(inherited(stack, own, skillsOf));
  const ownSkills = loaded?.at(-1)?.skills;

  const subagents = shown(
    inherited(stack, own, (layer) =>
      (layerOf(layer)?.agents ?? []).map(
        (agent) => [agent.path, agent] as const,
      ),
    ),
  );

  const workflows = shown(
    inherited(stack, own, (layer) =>
      (layerOf(layer)?.workflows ?? []).map(
        (workflow) => [workflow.path, workflow] as const,
      ),
    ),
  );

  const ownAgents = loaded?.at(-1)?.agents;
  const ownSkillsOff = offSkills(content.settings);

  const offered = {
    mcp: [
      ...inherited(stack, own, itemsOf.mcp)
        .filter(({ off }) => !off)
        .map(({ item }) => item.name),
      ...Object.keys(content.mcpServers),
    ],
    skills: [
      ...inherited(stack, own, skillsOf)
        .filter(({ off }) => !off)
        .map(({ item }) => item.name),
      ...(ownSkills ?? [])
        .filter(({ folder }) => !ownSkillsOff.has(folder))
        .map((each) => each.name),
    ],
    agents: [
      ...builtinAgents,
      ...inherited(stack, own, (layer) =>
        (layerOf(layer)?.agents ?? []).map(
          (agent) => [agent.path, agent.name] as const,
        ),
      )
        .filter(({ off }) => !off)
        .map(({ item }) => item),
      ...(ownAgents ?? []).map((each) => each.name),
    ],
  };

  const ownPrompts = own.paths.flatMap((path) => {
    const prompt = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

    return prompt === undefined ? [] : [prompt];
  });

  const copy = (from: StackLayer, key: string): void => {
    void copying.run(from, key);
  };

  const itemsLayer: ItemsLayer = {
    folder: target.folder,
    owner: name,
    editable,
    onToggleInherited: toggle,
    onCopy: copy,
  };

  return (
    <>
      {below.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-label">
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {target.preview === true && (
              <PreviewButton
                profileId={target.id}
                name={name}
                layers={[...stack, own]}
              />
            )}
            <Segmented
              label="Show"
              options={[
                { value: "all", label: "Everything Pi gets" },
                { value: "own", label: `Only ${name}'s own` },
              ]}
              value={onlyOwn ? "own" : "all"}
              onChange={(value) => {
                setOnlyOwn(value === "own");
              }}
            />
          </span>
        </div>
      )}
      <ErrorText size="caption" className="mt-4">
        {update.error ?? copying.error}
      </ErrorText>
      {agents.length === 0 ? (
        <Instructions
          text={content.agentsMd}
          edit={target.tab("instructions")}
        />
      ) : (
        <Section
          title="Instructions"
          description="AGENTS.md, joined in this order"
          actions={
            <a
              href={target.tab("instructions")}
              aria-label="Edit instructions"
              className="rounded-md px-2 py-1 text-label text-fg-dim hover:bg-hover hover:text-fg"
            >
              Edit
            </a>
          }
        >
          <Rows label="Instructions">
            {agents.map((entry) => (
              <InheritedRow
                key={entry.key}
                entry={entry}
                title={firstLine(entry.item)}
                description={`${String(entry.item.trim().split("\n").length)} lines`}
                owner={name}
                editable={editable}
                onToggle={toggle}
              />
            ))}
            {content.agentsMd.trim() !== "" && (
              <Row
                title={firstLine(content.agentsMd)}
                description={`${String(content.agentsMd.trim().split("\n").length)} lines`}
              >
                <SourceTag name={name} kind="own" />
              </Row>
            )}
          </Rows>
        </Section>
      )}
      <SystemPromptCard
        key={`${content.systemMd}:${content.appendSystemMd}`}
        content={content}
        editable={editable}
        onSave={save}
      >
        {append.length > 0 && (
          <Rows label="Added below">
            {append.map((entry) => (
              <InheritedRow
                key={entry.key}
                entry={entry}
                title={firstLine(entry.item)}
                description="Added to Pi's prompt before this one's"
                owner={name}
                editable={editable}
                onToggle={toggle}
              />
            ))}
          </Rows>
        )}
      </SystemPromptCard>
      <Skills
        skills={ownSkills}
        off={offSkills(content.settings)}
        inherited={skills}
        owner={name}
        editable={editable}
        add={target.tab("skills")}
        onToggle={(folder, on) => {
          save({ settings: withSkill(content.settings, folder, on) });
        }}
        onToggleInherited={toggle}
        onCopy={copy}
      />
      <Agents
        layer={itemsLayer}
        agents={ownAgents}
        inherited={subagents}
        mcpServers={[...new Set(offered.mcp)]}
        skills={[...new Set(offered.skills)]}
      />
      <Workflows
        layer={itemsLayer}
        workflows={loaded?.at(-1)?.workflows}
        inherited={workflows}
        agents={offered.agents}
      />
      <Packages
        packages={content.packages}
        editable={editable}
        onSave={(next) => {
          save({ packages: next });
        }}
      >
        {packages.map((entry) => {
          const source = sourceOf(entry.item);

          return (
            <InheritedRow
              key={entry.key}
              entry={entry}
              initials={source.slice(0, 2)}
              title={nameOf(source)}
              description={<span className="font-mono">{source}</span>}
              owner={name}
              editable={editable}
              onToggle={toggle}
            />
          );
        })}
      </Packages>
      <Section
        title="MCP servers"
        actions={
          editable && <AddLink href={target.tab("mcp")} label="Add server" />
        }
      >
        {(Object.keys(content.mcpServers).length > 0 || mcp.length > 0) && (
          <Rows label="MCP servers">
            {mcp.map((entry) => (
              <InheritedRow
                key={entry.key}
                entry={entry}
                initials={initialsOf(entry.item.name)}
                title={entry.item.name}
                description={
                  <span className="font-mono">
                    {serverOf(entry.item.config)}
                  </span>
                }
                owner={name}
                editable={editable}
                onToggle={toggle}
              />
            ))}
            {Object.entries(content.mcpServers).map(([server, config]) => (
              <Row
                key={server}
                initials={initialsOf(server)}
                title={server}
                description={
                  <span className="font-mono">{serverOf(config)}</span>
                }
              >
                {below.length > 0 && <SourceTag name={name} kind="own" />}
              </Row>
            ))}
          </Rows>
        )}
      </Section>
      {children}
      <Section title="Prompts" description="Slash commands in the composer">
        <ul aria-label="Prompts" className="flex flex-wrap gap-1.5">
          {prompts.map((entry) => (
            <li key={entry.key}>
              <Chip
                mono
                className={entry.off ? "line-through opacity-60" : ""}
                {...(editable && {
                  onRemove: () => {
                    toggle(entry.key, entry.off);
                  },
                  removeLabel: entry.off
                    ? `Turn /${entry.item} back on in ${name}`
                    : `Turn off /${entry.item} in ${name}`,
                })}
              >
                /{entry.item}
                <span className="ml-1.5 font-sans text-caption text-fg-dim">
                  {entry.from.name}
                </span>
              </Chip>
            </li>
          ))}
          {ownPrompts.map((prompt) => (
            <li key={prompt}>
              <Chip mono>/{prompt}</Chip>
            </li>
          ))}
          {editable && (
            <li>
              <a
                href={target.tab("prompts")}
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
