import { errorText } from "@pipoca/protocol";
import {
  type Attachment,
  AttachRow,
  type SessionAttachProps,
  type ToolCallProps,
  useApi,
  useDraft,
  useLoaded,
  useNewSession,
  useOverlay,
  useViewer,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  ChoiceCard,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  EmptyState,
  ErrorText,
  Field,
  Icon,
  SearchInput,
  Segmented,
  Tabs,
  TextArea,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactView,
  type Purpose,
  purposeOf,
  purposes,
  type Template,
  type TemplateScope,
  typeLabel,
} from "../src/artifacts";
import { base } from "./collaborate";
import { useSize } from "./size";

const scopeLabels: Readonly<Record<TemplateScope, string>> = {
  builtin: "Built in",
  server: "Server",
  mine: "Mine",
};

const purposeLabels: Readonly<Record<Purpose, string>> = {
  present: "Present",
  discuss: "Discuss",
  design: "Design",
  report: "Report",
};

const emptyScopes: Readonly<Record<TemplateScope, string>> = {
  builtin: "Nothing matches.",
  server: "No admin has shared a template with everyone on the server yet.",
  mine: "Save an artifact as a template from its More menu, and it shows here.",
};

const blank = "blank";

// What the person says to start from a template, in their words, and the
// template it means for Pi beside it. Someone else may have named it, so
// the name goes to Pi as data.
function startFrom(template: Template): {
  readonly text: string;
  readonly attachment: Attachment;
} {
  return {
    text: `Start from the ${template.name} template.`,
    attachment: {
      key: `template:${template.id}`,
      icon: "file-text",
      title: template.name,
      detail: `template · ${typeLabel(template.type)}`,
      ...(template.scope === "mine" && { personal: true }),
      text: `The template ${JSON.stringify(template.name)} (${template.id}): start from it with start_artifact, then follow its instructions.`,
    },
  };
}

// own says whether the person's own are offered: not in team work.
type Loaded =
  | { readonly templates: readonly Template[]; readonly own: boolean }
  | { readonly problem: string };

// The person's templates, or the ones a Session's Pi can start from, or
// why they couldn't be loaded, for a Retry in place of the page going
// down.
function useTemplates(
  open: boolean,
  session?: string,
): {
  readonly loaded: Loaded | undefined;
  readonly retry: () => void;
} {
  const api = useApi(plugin);

  const { value, reload } = useLoaded(
    async (): Promise<Loaded | undefined> => {
      if (!open) {
        return undefined;
      }

      try {
        return await api.get<{ templates: Template[]; own: boolean }>(
          session === undefined
            ? "templates"
            : `templates?session=${encodeURIComponent(session)}`,
        );
      } catch (error) {
        return { problem: errorText(error) };
      }
    },
    open ? `templates:${session ?? ""}` : "",
    { changes: ["artifacts"] },
  );

  return { loaded: value, retry: reload };
}

function Failed({
  problem,
  onRetry,
}: {
  readonly problem: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col items-start gap-2.5">
      <ErrorText>{`Couldn't load the templates. ${problem}`}</ErrorText>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  );
}

// Phones open the picker on its tiles, not with the keyboard over them.
function searchFirst(): boolean {
  return (
    typeof matchMedia !== "function" || matchMedia("(min-width: 768px)").matches
  );
}

// Artifacts › New and the composer's Start from template (ADR 0085): a
// template to start from, with what Pi will be told. onStart puts it in the
// current Session's composer; without it, the New session composer opens.
export function TemplatePicker({
  open,
  session,
  onClose,
  onStart,
}: {
  readonly open: boolean;
  // The Session it starts in, whose Pi can start only from some.
  readonly session?: string;
  readonly onClose: () => void;
  readonly onStart?: (text: string, attachment: Attachment) => void;
}): ReactElement {
  const titleId = useId();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      size="full"
      initialFocus={
        searchFirst() ? 'input[type="search"]' : 'button[aria-label="Close"]'
      }
    >
      <Picker
        titleId={titleId}
        {...(session !== undefined && { session })}
        onClose={onClose}
        {...(onStart !== undefined && { onStart })}
      />
    </Dialog>
  );
}

function Picker({
  titleId,
  session,
  onClose,
  onStart,
}: {
  readonly titleId: string;
  readonly session?: string;
  readonly onClose: () => void;
  readonly onStart?: (text: string, attachment: Attachment) => void;
}): ReactElement {
  const api = useApi(plugin);
  const newSession = useNewSession();
  const { open } = useOverlay();
  const { loaded, retry } = useTemplates(true, session);

  const scopes = (["builtin", "server", "mine"] as const).filter(
    (each) =>
      each !== "mine" ||
      loaded === undefined ||
      !("own" in loaded) ||
      loaded.own,
  );

  const [scope, setScope] = useState<TemplateScope>("builtin");
  const [purpose, setPurpose] = useState<Purpose | "">("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);

  const all =
    loaded !== undefined && "templates" in loaded ? loaded.templates : [];

  const matching = all.filter(
    (each) =>
      (purpose === "" || each.for === purpose) &&
      words.every((word) =>
        `${each.name} ${each.description}`.toLowerCase().includes(word),
      ),
  );

  const shown = matching.filter((each) => each.scope === scope);

  // Starting from nothing, in a new Session only.
  const blankShown =
    loaded !== undefined &&
    "templates" in loaded &&
    onStart === undefined &&
    scope === "builtin" &&
    words.length === 0 &&
    purpose === "";

  const selected =
    shown.find(({ id }) => id === picked) ??
    (picked === blank && blankShown ? undefined : shown[0]);

  const blankPicked = blankShown && selected === undefined;

  const start = (template: Template): void => {
    const { text, attachment } = startFrom(template);

    onClose();

    if (onStart === undefined) {
      newSession(text, [attachment]);
    } else {
      onStart(text, attachment);
    }
  };

  const startBlank = (template: Template): void => {
    setBusy(true);
    setProblem(undefined);

    void api
      .post<{ id: string }>(
        `templates/${encodeURIComponent(template.id)}/start`,
        { title: template.name },
      )
      .then(({ id }) => {
        onClose();
        open({ artifact: id });
      })
      .catch((error: unknown) => {
        setProblem(errorText(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const startLabel =
    onStart === undefined
      ? "Start with Pi in a new Session…"
      : "Start with Pi in this Session…";

  const startButton = (): ReactNode => {
    if (blankPicked) {
      return (
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            newSession("");
          }}
        >
          Start with Pi in a new Session…
        </Button>
      );
    }

    return (
      selected !== undefined && (
        <Button
          variant="primary"
          onClick={() => {
            start(selected);
          }}
        >
          {startLabel}
        </Button>
      )
    );
  };

  const empty = (): ReactElement => {
    if (loaded !== undefined && "problem" in loaded) {
      return <Failed problem={loaded.problem} onRetry={retry} />;
    }

    return (
      <EmptyState>
        {words.length > 0 || purpose !== ""
          ? `Nothing matches here.${hint(matching, scope, scopes)}`
          : emptyScopes[scope]}
      </EmptyState>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto rounded-[inherit] md:flex-row md:overflow-hidden">
      <div className="flex min-w-0 flex-col max-md:shrink-0 md:min-h-0 md:flex-1 md:overflow-y-auto">
        <div className="flex flex-wrap items-center gap-3 px-5.5 pt-4.5 pb-2.5">
          <h2
            id={titleId}
            className="flex-1 text-[18px] font-semibold text-fg-strong"
          >
            New artifact
          </h2>
          <SearchInput
            aria-label="Search templates"
            placeholder="Search templates"
            className="order-last basis-full sm:order-none sm:w-64 sm:basis-auto"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
        <div className="px-5.5">
          <Tabs
            label="Whose templates"
            value={scope}
            tabs={scopes.map((each) => ({
              value: each,
              label: `${scopeLabels[each]} ${String(matching.filter((template) => template.scope === each).length)}`,
            }))}
            onSelect={(each) => {
              setScope(each);
              setPicked(undefined);
            }}
          />
        </div>
        <div className="overflow-x-auto px-5.5 py-4">
          <Segmented
            label="What it's for"
            value={purpose}
            options={[
              { value: "" as const, label: "All" },
              ...purposes.map((each) => ({
                value: each,
                label: purposeLabels[each],
              })),
            ]}
            onChange={(each) => {
              setPurpose(each);
              setPicked(undefined);
            }}
          />
        </div>
        {loaded !== undefined && shown.length === 0 && !blankShown ? (
          <div className="px-5.5 pb-5.5">{empty()}</div>
        ) : (
          <div
            role="radiogroup"
            aria-label="Templates"
            className="grid grid-cols-2 gap-3.5 px-5.5 pb-5.5 lg:grid-cols-4"
          >
            {shown.map((each) => (
              <Tile
                key={each.id}
                value={each.id}
                checked={each.id === selected?.id}
                title={each.name}
                caption={each.description}
                onPick={setPicked}
              >
                <Preview template={each} className="h-23" />
              </Tile>
            ))}
            {blankShown && (
              <Tile
                value={blank}
                checked={blankPicked}
                dashed
                title="Blank"
                caption="Nothing to start from: tell Pi what to make."
                onPick={setPicked}
              >
                <span
                  aria-hidden="true"
                  className="grid h-23 w-full place-items-center rounded-md border border-dashed border-line-strong text-fg-dim"
                >
                  <Icon name="plus" />
                </span>
              </Tile>
            )}
          </div>
        )}
      </div>
      <aside
        aria-label={
          blankPicked ? "Blank" : `${selected?.name ?? "No"} template`
        }
        className="flex shrink-0 flex-col gap-4 border-line bg-panel p-5 max-md:border-t md:w-90 md:overflow-y-auto md:border-l"
      >
        {selected === undefined ? (
          <>
            <span className="grid h-42.5 place-items-center rounded-md border border-dashed border-line text-label text-fg-dim">
              {blankPicked ? "A new Session, empty" : "No template picked"}
            </span>
            <span className="text-label text-fg-dim">
              {blankPicked
                ? "Pi starts from nothing, with what you tell it."
                : "Pick a template to see its files and what Pi will be told."}
            </span>
            <span className="flex-1" />
            <span className="flex flex-col max-md:hidden">{startButton()}</span>
          </>
        ) : (
          <>
            <Preview template={selected} className="h-42.5" />
            <div className="flex flex-col gap-1">
              <span className="text-ui font-semibold text-fg-strong">
                {selected.name}
              </span>
              <span className="text-label text-fg-dim">
                {selected.description}
              </span>
              <span className="text-caption text-fg-dim">
                {[
                  typeLabel(selected.type),
                  purposeLabels[selected.for],
                  ...(selected.scope === "builtin"
                    ? []
                    : [`saved by ${selected.by}`]),
                ].join(" · ")}
              </span>
              {selected.scope === "mine" && (
                <span className="text-caption text-fg-dim">
                  Yours alone, so it starts your own work, not the team&apos;s.
                </span>
              )}
            </div>
            <Detail label="Pi will be told">
              <Told key={selected.id} template={selected} />
            </Detail>
            <Detail label="Files">
              <span className="font-mono text-mono-sm">
                {selected.files.join(" · ")}
              </span>
            </Detail>
            <span className="flex-1" />
            <ErrorText size="caption">{problem}</ErrorText>
            <span className="flex flex-col gap-2 max-md:hidden">
              {startButton()}
            </span>
            {onStart === undefined && (
              <>
                <Button
                  variant="ghost"
                  disabled={busy || !editable(selected)}
                  onClick={() => {
                    startBlank(selected);
                  }}
                >
                  Start blank and edit myself
                </Button>
                {!editable(selected) && (
                  <span className="text-caption text-fg-dim">
                    Only Pi edits pages, slides and canvases, so start this one
                    with Pi.
                  </span>
                )}
              </>
            )}
          </>
        )}
      </aside>
      {(selected !== undefined || blankPicked) && (
        <div className="sticky bottom-0 flex shrink-0 items-center gap-3 border-t border-line bg-elevated px-5.5 py-3 md:hidden">
          <span className="min-w-0 flex-1 truncate text-label font-medium text-fg-strong">
            {selected?.name ?? "Blank"}
          </span>
          {startButton()}
        </div>
      )}
    </div>
  );
}

// Which other tab has what the search finds.
function hint(
  matching: readonly Template[],
  scope: TemplateScope,
  scopes: readonly TemplateScope[],
): string {
  const elsewhere = scopes.filter(
    (each) =>
      each !== scope && matching.some((template) => template.scope === each),
  );

  return elsewhere.length === 0
    ? ""
    : ` ${elsewhere.map((each) => scopeLabels[each]).join(" and ")} ${elsewhere.length === 1 ? "has" : "have"} some.`;
}

// One template to pick, a radio among the others: arrow keys move between
// them, and the picked one is outlined apart from the focus ring.
function Tile({
  value,
  checked,
  dashed = false,
  title,
  caption,
  onPick,
  children,
}: {
  readonly value: string;
  readonly checked: boolean;
  readonly dashed?: boolean;
  readonly title: string;
  readonly caption: string;
  readonly onPick: (value: string) => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border bg-elevated p-2.5 transition-[border-color,box-shadow] duration-150 hover:border-line-strong",
        dashed ? "border-dashed border-line-strong" : "border-line",
        "has-checked:border-solid has-checked:border-accent has-checked:bg-hover has-checked:shadow-[inset_0_0_0_1px_var(--accent)]",
        "has-focus-visible:ring-3 has-focus-visible:ring-focus",
      )}
    >
      <input
        type="radio"
        name="template"
        value={value}
        checked={checked}
        onChange={() => {
          onPick(value);
        }}
        className="sr-only"
      />
      {children}
      <span className="truncate text-label font-semibold text-fg-strong">
        {title}
      </span>
      <span className="line-clamp-2 text-caption text-fg-dim">{caption}</span>
    </label>
  );
}

// What Pi is told, all of it once asked.
function Told({ template }: { readonly template: Template }): ReactElement {
  const [whole, setWhole] = useState(false);

  const text = [
    ...(template.example ? ["Its files are an example to write from."] : []),
    template.instructions === ""
      ? "Nothing more than to start from its files."
      : template.instructions,
  ].join(" ");

  const long = text.length > 280;

  return (
    <span className="flex flex-col items-start gap-1">
      <span
        className={cn("whitespace-pre-wrap", long && !whole && "line-clamp-5")}
      >
        {text}
      </span>
      {long && (
        <button
          type="button"
          aria-expanded={whole}
          className="cursor-pointer text-caption font-medium text-accent hover:underline"
          onClick={() => {
            setWhole(!whole);
          }}
        >
          {whole ? "Show less" : "Show all"}
        </button>
      )}
    </span>
  );
}

// Only a Markdown doc is edited by hand (ADR 0082).
function editable(template: Template): boolean {
  return template.entry.endsWith(".md");
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-fg-dim">{label}</span>
      <span className="text-label text-fg">{children}</span>
    </div>
  );
}

// The width a template's page is drawn at before it's shrunk to fit.
const drawnWidth = 1280;

// The template's entry drawn small in a sandbox, as the gallery draws an
// artifact's first screen, shrunk to fit its box whatever its width.
function Preview({
  template,
  className,
}: {
  readonly template: Template;
  readonly className: string;
}): ReactElement {
  const [measure, size] = useSize();
  const scale = size.width > 0 ? size.width / drawnWidth : 0.25;

  return (
    <span
      ref={measure}
      aria-hidden="true"
      className={cn(
        "relative block w-full overflow-hidden rounded-md border border-line bg-canvas",
        className,
      )}
    >
      <iframe
        title={template.name}
        tabIndex={-1}
        loading="lazy"
        src={`${base}/${template.preview}`}
        sandbox="allow-scripts"
        style={{
          width: `${String(drawnWidth)}px`,
          height: `${String(size.height > 0 ? size.height / scale : 400)}px`,
          transform: `scale(${String(scale)})`,
        }}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
      />
    </span>
  );
}

// The composer's + menu: the picked template waits in this Session's
// composer, in the person's words, for them to send.
export function StartFromTemplate({
  session,
}: SessionAttachProps): ReactElement {
  const [picking, setPicking] = useState(false);
  const draft = useDraft();

  return (
    <>
      <AttachRow
        icon="file-text"
        label="Start from template…"
        onPick={() => {
          setPicking(true);
        }}
      />
      <TemplatePicker
        open={picking}
        session={session.id}
        onClose={() => {
          setPicking(false);
        }}
        onStart={(text, attachment) => {
          draft(session.id, text, [attachment]);
        }}
      />
    </>
  );
}

// Where Pi started from a template in the chat.
export function StartedCard({ call }: ToolCallProps): ReactElement {
  const details = call.result?.details as
    { template?: unknown; folder?: unknown; files?: unknown } | undefined;

  const asked = (call.args as { template?: unknown } | undefined)?.template;

  const named = typeof asked === "string" ? asked : "a template";

  const name = typeof details?.template === "string" ? details.template : named;

  const where =
    typeof details?.folder === "string" && typeof details.files === "number"
      ? ` · ${String(details.files)} ${details.files === 1 ? "file" : "files"} in ${details.folder.split("/").at(-1) ?? details.folder}`
      : "";

  return (
    <div className="flex max-w-full min-w-0 items-center gap-2 text-label text-fg-dim">
      <Icon name="file-text" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">
        {call.status === "failed" ? (
          (call.result?.text ?? "Couldn't start from the template")
        ) : (
          <>
            {call.status === "running"
              ? "Starting from template "
              : "Started from template "}
            <b className="font-medium text-fg">{name}</b>
            {where}
          </>
        )}
      </span>
    </div>
  );
}

type Keeps = "structure" | "example";

// The viewer's Save as template (ADR 0085), or a template's own settings.
export function SaveTemplateDialog({
  artifact,
  settings = false,
  open,
  onSaved,
  onClose,
}: {
  readonly artifact: ArtifactView;
  // Changes the template the artifact is, instead of saving a new one.
  readonly settings?: boolean;
  readonly open: boolean;
  readonly onSaved: (said: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { loaded, retry } = useTemplates(open && settings);

  const template =
    loaded !== undefined && "templates" in loaded
      ? loaded.templates.find(({ id }) => id === artifact.id)
      : undefined;

  const waiting = (): ReactElement => {
    if (loaded === undefined) {
      return <span className="text-label text-fg-dim">Loading…</span>;
    }

    return "problem" in loaded ? (
      <Failed problem={loaded.problem} onRetry={retry} />
    ) : (
      <ErrorText>
        This template is gone, or isn&apos;t yours to change.
      </ErrorText>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={settings ? "Template settings" : "Save as template"}
      description={`${settings ? "" : "From "}“${artifact.title}” · ${typeLabel(artifact.type)}`}
    >
      {settings && template === undefined ? (
        <DialogBody>{waiting()}</DialogBody>
      ) : (
        <SaveTemplateForm
          artifact={artifact}
          {...(template !== undefined && { template })}
          onSaved={onSaved}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function SaveTemplateForm({
  artifact,
  template,
  onSaved,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly template?: Template;
  readonly onSaved: (said: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const { person } = useViewer();
  const [name, setName] = useState(template?.name ?? artifact.title);
  const [description, setDescription] = useState(template?.description ?? "");

  const [purpose, setPurpose] = useState<Purpose>(
    template?.for ?? artifact.template?.for ?? purposeOf(artifact.type),
  );

  const [keeps, setKeeps] = useState<Keeps>(
    artifact.ownSession ? "structure" : "example",
  );

  const [instructions, setInstructions] = useState(
    template?.instructions ?? "",
  );

  const [scope, setScope] = useState<"mine" | "server">("mine");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const keepsId = useId();

  const save = async (): Promise<string> => {
    const fields = {
      name: name.trim(),
      for: purpose,
      // A new one without a description says where it came from.
      ...((template !== undefined || description.trim() !== "") && {
        description: description.trim(),
      }),
      instructions,
    };

    if (template !== undefined) {
      await api.put(`artifacts/${artifact.id}/template`, fields);

      return "Template saved";
    }

    await api.post(`artifacts/${artifact.id}/template`, {
      ...fields,
      scope,
      keeps,
    });

    return keeps === "structure"
      ? "Pi is making the template in its Session"
      : "Saved as a template";
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(undefined);

        save()
          .then(onSaved)
          .catch((error: unknown) => {
            setProblem(errorText(error));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <DialogBody>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Name">
            <TextInput
              value={name}
              maxLength={200}
              required
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={description}
              maxLength={500}
              placeholder={`From “${artifact.title}”`}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-medium text-fg">For</span>
          <div className="w-fit max-w-full overflow-x-auto">
            <Segmented
              label="For"
              value={purpose}
              options={purposes.map((each) => ({
                value: each,
                label: purposeLabels[each],
              }))}
              onChange={setPurpose}
            />
          </div>
        </div>
        {template === undefined && (
          <div
            role="radiogroup"
            aria-labelledby={keepsId}
            className="flex flex-col gap-1.5"
          >
            <span id={keepsId} className="text-label font-medium text-fg">
              What the template keeps
            </span>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <ChoiceCard
                name="keeps"
                value="structure"
                checked={keeps === "structure"}
                disabled={!artifact.ownSession}
                onChange={() => {
                  setKeeps("structure");
                }}
                title="The structure"
                description={
                  artifact.ownSession
                    ? "Headings, sections and styles. Pi takes out this artifact's text and leaves a placeholder in each part, in its Session."
                    : "Pi does this in the artifact's own Session, for the person whose Session it is, and that Session is gone, archived or not yours."
                }
              />
              <ChoiceCard
                name="keeps"
                value="example"
                checked={keeps === "example"}
                onChange={() => {
                  setKeeps("example");
                }}
                title="Everything, as an example"
                description="The whole artifact stays. Pi reads it as an example and writes a new one in its shape."
              />
            </div>
          </div>
        )}
        <Field
          label="What Pi should know"
          hint="Such as what to ask before writing, and the rules the team keeps."
        >
          <TextArea
            rows={3}
            value={instructions}
            maxLength={20_000}
            onChange={(event) => {
              setInstructions(event.target.value);
            }}
          />
        </Field>
        {template === undefined && (
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-fg">
              Who can use it
            </span>
            <div className="w-fit">
              {person.admin ? (
                <Segmented
                  label="Who can use it"
                  value={scope}
                  options={[
                    { value: "mine", label: "Only me" },
                    { value: "server", label: "Everyone on the server" },
                  ]}
                  onChange={setScope}
                />
              ) : (
                <Badge>Only me</Badge>
              )}
            </div>
            <span className="text-caption text-fg-dim">
              {person.admin
                ? "Only me works in your personal workspace too."
                : "Only admins share a template with everyone on the server. Yours works in your personal workspace too."}
            </span>
          </div>
        )}
        <ErrorText size="caption">{problem}</ErrorText>
      </DialogBody>
      <DialogFoot>
        <span className="flex-1 text-caption text-fg-dim max-sm:basis-full">
          A template is an artifact too: open it, version it, comment on it.
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || name.trim() === ""}
        >
          {template === undefined ? "Save template" : "Save"}
        </Button>
      </DialogFoot>
    </form>
  );
}
