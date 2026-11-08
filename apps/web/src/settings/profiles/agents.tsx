import { thinkingLevels } from "@pipoca/protocol";
import {
  Button,
  Card,
  cardClass,
  Checkbox,
  Chip,
  cn,
  ErrorText,
  Field,
  Icon,
  ListInput,
  Menu,
  Section,
  Select,
  Switch,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  type AgentFile,
  agentText,
  newAgent,
  startedAgents,
  type WorkflowFile,
  workflowAbout,
  workflowPath,
  workflowTemplate,
} from "./agent-files";
import { useRun } from "./files";
import type { Folder } from "./folder";
import { SourceTag } from "./inherited";
import type { Inherited, StackLayer } from "./stack";

// What the Agents and Workflows sections share with the open layer's page.
export interface ItemsLayer {
  readonly folder: Folder;
  readonly owner: string;
  readonly editable: boolean;
  readonly onToggleInherited: (key: string, on: boolean) => void;
  readonly onCopy: (from: StackLayer, key: string) => void;
}

// The subagents plugin finds saved workflows by a name without folders.
const namePattern = /^[\w-][\w.-]*$/;

export function Agents({
  layer,
  agents,
  inherited,
  mcpServers,
  skills,
}: {
  readonly layer: ItemsLayer;
  // The open layer's own, still reading while undefined.
  readonly agents: readonly AgentFile[] | undefined;
  readonly inherited: readonly Inherited<AgentFile>[];
  // What the Profile has for its agents to pick from.
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
}): ReactElement {
  const [open, setOpen] = useState<AgentFile>();
  const [error, run] = useRun();

  const save = (agent: AgentFile): void => {
    run(async () => {
      await layer.folder.write(agent.path, agentText(agent));
      setOpen(undefined);
    });
  };

  const remove = (agent: AgentFile): void => {
    run(async () => {
      await layer.folder.remove(agent.path);
      setOpen(undefined);
    });
  };

  return (
    <ItemsSection
      title="Agents"
      noun="agent"
      layer={layer}
      own={agents?.map((agent) => ({
        key: agent.path,
        name: agent.name,
        about: agent.description,
      }))}
      inherited={inherited.map((entry) => ({
        entry,
        name: entry.item.name,
        about: entry.item.description,
      }))}
      onOpen={(key) => {
        setOpen(agents?.find(({ path }) => path === key));
      }}
      onAdd={(name) => {
        setOpen(newAgent(name));
      }}
      error={error}
    >
      {open && (
        <AgentEditor
          key={open.path}
          agent={open}
          editable={layer.editable}
          isNew={!(agents ?? []).some(({ path }) => path === open.path)}
          mcpServers={mcpServers}
          skills={skills}
          onSave={save}
          onDelete={remove}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </ItemsSection>
  );
}

export function Workflows({
  layer,
  workflows,
  inherited,
  agents,
}: {
  readonly layer: ItemsLayer;
  readonly workflows: readonly WorkflowFile[] | undefined;
  readonly inherited: readonly Inherited<WorkflowFile>[];
  // The agents a workflow of this Profile can start.
  readonly agents: readonly string[];
}): ReactElement {
  const [open, setOpen] = useState<WorkflowFile>();
  const [error, run] = useRun();

  const about = ({ script }: WorkflowFile): string => {
    const started = startedAgents(script);

    return (
      workflowAbout(script) ||
      (started.length === 0 ? "" : `Starts ${started.join(", ")}`)
    );
  };

  return (
    <ItemsSection
      title="Workflows"
      noun="workflow"
      layer={layer}
      own={workflows?.map((workflow) => ({
        key: workflow.path,
        name: workflow.name,
        about: about(workflow),
      }))}
      inherited={inherited.map((entry) => ({
        entry,
        name: entry.item.name,
        about: about(entry.item),
      }))}
      onOpen={(key) => {
        setOpen(workflows?.find(({ path }) => path === key));
      }}
      onAdd={(name) => {
        setOpen({ path: workflowPath(name), name, script: workflowTemplate });
      }}
      error={error}
    >
      {open && (
        <WorkflowEditor
          key={open.path}
          workflow={open}
          editable={layer.editable}
          isNew={!(workflows ?? []).some(({ path }) => path === open.path)}
          agents={agents}
          onSave={(script) => {
            run(async () => {
              await layer.folder.write(open.path, script);
              setOpen(undefined);
            });
          }}
          onDelete={() => {
            run(async () => {
              await layer.folder.remove(open.path);
              setOpen(undefined);
            });
          }}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </ItemsSection>
  );
}

interface Item {
  readonly key: string;
  readonly name: string;
  readonly about: string;
}

// A layer's own items and the ones it inherits, as the Skills section shows
// them, with an editor for the one open.
function ItemsSection({
  title,
  noun,
  layer,
  own: given,
  inherited,
  onOpen,
  onAdd,
  error,
  children,
}: {
  readonly title: string;
  readonly noun: string;
  readonly layer: ItemsLayer;
  readonly own: readonly Item[] | undefined;
  readonly inherited: readonly {
    readonly entry: Inherited<unknown>;
    readonly name: string;
    readonly about: string;
  }[];
  readonly onOpen: (key: string) => void;
  readonly onAdd: (name: string) => void;
  readonly error: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  const { owner, editable } = layer;
  const own = given ?? [];
  const replaced = new Set(own.map(({ key }) => key));
  const below = inherited.filter(({ entry }) => !replaced.has(entry.key));
  const [adding, setAdding] = useState(false);
  const [invalid, setInvalid] = useState<string>();

  const description =
    given === undefined
      ? "Reading the folder"
      : [
          `${String(own.length)} own`,
          ...(below.length === 0
            ? []
            : [
                `${String(below.filter(({ entry }) => !entry.off).length)} inherited`,
              ]),
          ...(below.some(({ entry }) => entry.off)
            ? [`${String(below.filter(({ entry }) => entry.off).length)} off`]
            : []),
        ].join(", ");

  return (
    <Section
      title={title}
      description={description}
      actions={
        editable && (
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            <Icon name="plus" />
            Add {noun}
          </Button>
        )
      }
    >
      {own.length + below.length > 0 && (
        <ul
          aria-label={title}
          className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {own.map(({ key, name, about }) => {
            const replaces = inherited.find(({ entry }) => entry.key === key);

            return (
              <li key={key} className="flex min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    onOpen(key);
                  }}
                  className={cn(
                    cardClass,
                    "flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left hover:border-line-strong",
                  )}
                >
                  <span className="max-w-full truncate text-ui font-medium text-fg-strong">
                    {name}
                  </span>
                  <span className="max-w-full truncate text-label text-fg-dim">
                    {replaces
                      ? `Replaces ${replaces.entry.from.name}'s`
                      : about || key}
                  </span>
                </button>
              </li>
            );
          })}
          {below.map(({ entry, name, about }) => (
            <li
              key={entry.key}
              className={cn(
                cardClass,
                "flex min-w-0 items-center gap-3 bg-panel px-4 py-3",
                entry.off && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <span className="max-w-full truncate text-ui font-medium text-fg-strong">
                  {name}
                </span>
                <span className="max-w-full truncate text-label text-fg-dim">
                  {entry.off ? `Off in ${owner}` : about || entry.key}
                </span>
                <SourceTag name={entry.from.name} kind={entry.from.kind} />
              </span>
              {editable && (
                <Menu
                  label={`More for ${name}`}
                  items={[
                    {
                      label: `Copy into ${owner} to change it`,
                      run: () => {
                        layer.onCopy(entry.from, entry.key);
                      },
                    },
                  ]}
                />
              )}
              <Switch
                label={`${name} in ${owner}`}
                labelHidden
                checked={!entry.off}
                disabled={!editable}
                onChange={(checked) => {
                  layer.onToggleInherited(entry.key, checked);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            const trimmed = typeof name === "string" ? name.trim() : "";

            if (!namePattern.test(trimmed)) {
              setInvalid(
                "Use letters, digits, dashes, dots and underscores, such as fix-bug.",
              );

              return;
            }

            setInvalid(undefined);
            setAdding(false);
            onAdd(trimmed);
          }}
          className="flex flex-wrap items-start gap-2"
        >
          <Field label={`New ${noun}'s name`} error={invalid}>
            <TextInput
              name="name"
              autoFocus
              placeholder={noun === "agent" ? "fix-bug" : "review-loop"}
              aria-invalid={invalid !== undefined}
              className="min-w-48 font-mono"
            />
          </Field>
          <span className="flex gap-2 self-end">
            <Button type="submit" variant="primary">
              Add
            </Button>
            <Button
              onClick={() => {
                setAdding(false);
                setInvalid(undefined);
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}
      {children}
      <ErrorText size="caption">{error}</ErrorText>
    </Section>
  );
}

function AgentEditor({
  agent,
  editable,
  isNew,
  mcpServers,
  skills,
  onSave,
  onDelete,
  onClose,
}: {
  readonly agent: AgentFile;
  readonly editable: boolean;
  readonly isNew: boolean;
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  readonly onSave: (agent: AgentFile) => void;
  readonly onDelete: (agent: AgentFile) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(agent);

  const change = (next: Partial<AgentFile>): void => {
    setDraft({ ...draft, ...next });
  };

  return (
    <EditorCard
      label={`Agent ${agent.name}`}
      path={agent.path}
      editable={editable}
      isNew={isNew}
      noun="agent"
      onSave={() => {
        onSave(draft);
      }}
      onDelete={() => {
        onDelete(agent);
      }}
      onClose={onClose}
    >
      <Field label="Description" hint="What the agent does and when to use it">
        <TextInput
          value={draft.description}
          placeholder="Fixes a reported bug with a regression test"
          onChange={(event) => {
            change({ description: event.target.value });
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model" hint="Empty uses the routine's or the Profile's">
          <TextInput
            value={draft.model}
            placeholder="provider/model"
            onChange={(event) => {
              change({ model: event.target.value });
            }}
            className="font-mono text-mono-sm"
          />
        </Field>
        <Field label="Thinking level">
          <Select
            value={draft.thinking}
            onChange={(event) => {
              change({
                thinking: event.target.value as AgentFile["thinking"],
              });
            }}
          >
            <option value="">The model&apos;s default</option>
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ListInput
        label="Tools"
        values={draft.tools}
        placeholder="read, bash or mcp__jira__search"
        onChange={(tools) => {
          change({ tools });
        }}
      />
      <Picks
        label="MCP servers"
        none="This Profile has no MCP servers."
        offered={mcpServers}
        picked={draft.mcp}
        onChange={(mcp) => {
          change({ mcp });
        }}
      />
      <Picks
        label="Skills"
        none="This Profile has no skills."
        offered={skills}
        picked={draft.skills}
        onChange={(picked) => {
          change({ skills: picked });
        }}
      />
      <Field label="Prompt">
        <TextArea
          value={draft.prompt}
          rows={8}
          placeholder="You are a careful engineer. Fix the bug the task names…"
          onChange={(event) => {
            change({ prompt: event.target.value });
          }}
          className="min-h-32 resize-y"
        />
      </Field>
    </EditorCard>
  );
}

// Which of the Profile's MCP servers or skills an agent gets. One it names
// that the Profile doesn't have stays listed, so it can be taken out.
function Picks({
  label,
  none,
  offered,
  picked,
  onChange,
}: {
  readonly label: string;
  readonly none: string;
  readonly offered: readonly string[];
  readonly picked: readonly string[];
  readonly onChange: (picked: readonly string[]) => void;
}): ReactElement {
  const names = [...new Set([...offered, ...picked])];

  return (
    <fieldset aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <legend className="pb-1.5 text-label font-medium text-fg">{label}</legend>
      {names.length === 0 ? (
        <span className="text-caption text-fg-dim">{none}</span>
      ) : (
        <span className="flex flex-wrap gap-x-5 gap-y-2">
          {names.map((name) => (
            <Checkbox
              key={name}
              label={<span className="font-mono text-mono-sm">{name}</span>}
              {...(!offered.includes(name) && {
                description: "Not in this Profile",
              })}
              checked={picked.includes(name)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...picked, name]
                    : picked.filter((each) => each !== name),
                );
              }}
            />
          ))}
        </span>
      )}
    </fieldset>
  );
}

function WorkflowEditor({
  workflow,
  editable,
  isNew,
  agents,
  onSave,
  onDelete,
  onClose,
}: {
  readonly workflow: WorkflowFile;
  readonly editable: boolean;
  readonly isNew: boolean;
  readonly agents: readonly string[];
  readonly onSave: (script: string) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [script, setScript] = useState(workflow.script);
  const started = startedAgents(script);

  return (
    <EditorCard
      label={`Workflow ${workflow.name}`}
      path={workflow.path}
      editable={editable}
      isNew={isNew}
      noun="workflow"
      onSave={() => {
        onSave(script);
      }}
      onDelete={onDelete}
      onClose={onClose}
    >
      <Field
        label="Script"
        hint={`Runs as /workflow ${workflow.name} in a sandbox with runs.run({ key, agent, task }), args and console, and no files, shell or network.`}
      >
        <TextArea
          value={script}
          rows={14}
          spellCheck={false}
          onChange={(event) => {
            setScript(event.target.value);
          }}
          className="min-h-56 resize-y font-mono text-mono-sm"
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-medium text-fg">Agents it starts</span>
        {started.length === 0 ? (
          <span className="text-caption text-fg-dim">
            None yet. A step names its agent as agent: &quot;worker&quot;.
          </span>
        ) : (
          <ul aria-label="Agents it starts" className="flex flex-wrap gap-1.5">
            {started.map((name) => (
              <li key={name}>
                <Chip mono>
                  {name}
                  {!agents.includes(name) && (
                    <span className="ml-1.5 font-sans text-caption text-failed">
                      not in this Profile
                    </span>
                  )}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </EditorCard>
  );
}

function EditorCard({
  label,
  path,
  editable,
  isNew,
  noun,
  onSave,
  onDelete,
  onClose,
  children,
}: {
  readonly label: string;
  readonly path: string;
  readonly editable: boolean;
  readonly isNew: boolean;
  readonly noun: string;
  readonly onSave: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const [ask, asking] = useConfirm();

  return (
    <Card padding="none" className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline gap-2.5">
        <h3 className="text-ui font-semibold text-fg-strong">{label}</h3>
        <span className="truncate font-mono text-caption text-fg-dim">
          {path}
        </span>
      </div>
      <fieldset
        aria-label={label}
        disabled={!editable}
        className="flex min-w-0 flex-col gap-4"
      >
        {children}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button variant="primary" onClick={onSave}>
            Save {noun}
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
        {editable && !isNew && (
          <Button
            variant="danger"
            onClick={() => {
              void ask({
                title: `Delete ${path}?`,
                confirm: `Delete ${noun}`,
                danger: true,
              }).then((yes) => {
                if (yes) {
                  onDelete();
                }
              });
            }}
          >
            Delete {noun}
          </Button>
        )}
      </div>
      {asking}
    </Card>
  );
}
