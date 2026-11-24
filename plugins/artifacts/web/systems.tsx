import { errorText } from "@pipoca/protocol";
import {
  AttachRow,
  ConfigForm,
  frameSandbox,
  type SessionAttachProps,
  useApi,
  useAttachOpen,
  useLoaded,
  useNewSession,
  useOverlay,
  useViewer,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  ChoiceCard,
  cn,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Icon,
  Menu,
  type MenuItem,
  Row,
  Rows,
  Section,
  Segmented,
  Select,
  Switch,
  tabPanelLabel,
  Tabs,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { artifacts as plugin } from "../plugin";
import { type ArtifactView, systemFormat, typeLabel } from "../src/artifacts";
import {
  changesOf,
  type SystemComponent,
  type SystemSummary,
  type Systems,
  type SystemView,
  type Unpicked,
  type UsedSystem,
} from "../src/systems";
import { base } from "./collaborate";
import { useSize } from "./size";

const builtIn = "pipoca";

const scopeLabels: Readonly<Record<SystemSummary["scope"], string>> = {
  builtin: "Built in",
  mine: "Mine",
  team: "Team",
  shared: "Shared",
};

const unpickedLabels: Readonly<Record<Unpicked, string>> = {
  default: "Use the default",
  ask: "Pi asks which",
  none: "No system",
};

// A component's page, or another file of a system, as its frame loads it.
export function systemFileSrc(
  id: string,
  version: number | undefined,
  file: string,
): string {
  return id === builtIn
    ? `${base}/systems/${builtIn}/files/${file.split("/").map(encodeURIComponent).join("/")}`
    : `${base}/artifacts/${id}/view?${version === undefined ? "" : `v=${String(version)}&`}path=${encodeURIComponent(file)}`;
}

function summaryLine(each: SystemSummary): string {
  return [
    each.scope === "shared" ? each.by : scopeLabels[each.scope],
    `v${String(each.version)}`,
    `used by ${String(each.usedBy)}`,
  ].join(" · ");
}

// A system's name without design system at its end, such as Acme.
function shortName(name: string): string {
  return name.replace(/\s+design system$/i, "") || name;
}

export function SystemThumb({
  id,
  thumb,
  className,
}: {
  readonly id: string;
  readonly thumb: SystemSummary["thumb"];
  readonly className?: string;
}): ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md border border-line text-label font-bold",
        className,
      )}
      style={{ background: thumb.ground, color: thumb.ink }}
    >
      {id === builtIn ? "p" : "Aa"}
    </span>
  );
}

// The systems the person sees, only while they're shown, and with a
// Session what it picked.
function useSystems(open: boolean, session?: string) {
  const api = useApi(plugin);

  return useLoaded(
    async (): Promise<Systems | { problem: string } | undefined> =>
      open
        ? api
            .get<Systems>(
              session === undefined
                ? "systems"
                : `systems?session=${encodeURIComponent(session)}`,
            )
            .catch((error: unknown) => ({ problem: errorText(error) }))
        : undefined,
    open ? `systems:${session ?? ""}` : "",
    { changes: ["artifacts"] },
  );
}

// What Pi is told when it's asked to make a system, beside the person's
// words.
const makeAttachment = {
  key: "design-system:make",
  icon: "file-text" as const,
  title: "Design system",
  detail: "how to make one",
  text: `Make a design system from what I point you to: read its colors, type, spacing and components. ${systemFormat} Keep README.md short: how to link the files, then the few rules that make things look right. Publish the folder with publish_artifact, entry README.md and a title that names it, such as "Acme design system".`,
};

// Settings › General (ADR 0085): the systems Pi makes things with, the
// person's own default and what Pi does when nothing is picked. The
// server's artifact settings, the team's default among them, are on its
// own page.
export function SystemSettings(): ReactElement {
  const api = useApi(plugin);
  const newSession = useNewSession();
  const { open } = useOverlay();
  const { person } = useViewer();
  const { value, reload } = useSystems(true);
  const [problem, setProblem] = useState<string>();
  const [previewed, setPreviewed] = useState(false);

  const put = (sent: object): void => {
    setProblem(undefined);

    void api
      .put("systems/settings", sent)
      .then(reload)
      .catch((error: unknown) => {
        setProblem(errorText(error));
      });
  };

  const loaded = value !== undefined && "systems" in value ? value : undefined;

  return (
    <Section
      title="Design systems"
      {...(person.admin && {
        actions: (
          <a
            href="#settings/artifacts"
            className="text-label text-fg-dim underline underline-offset-2 hover:text-fg"
          >
            Server settings for artifacts
          </a>
        ),
      })}
    >
      <p className="text-label text-fg-dim">
        What decks, canvases and pages look like when Pi makes them. A Session
        can pick another in the + menu.
      </p>
      {value !== undefined && "problem" in value && (
        <div className="flex flex-col items-start gap-2.5">
          <ErrorText>{`Couldn't load the design systems. ${value.problem}`}</ErrorText>
          <Button onClick={reload}>Retry</Button>
        </div>
      )}
      {value === undefined && (
        <p aria-busy className="text-label text-fg-dim">
          Loading the design systems…
        </p>
      )}
      {loaded !== undefined && (
        <div className="flex flex-col gap-5.5">
          <Rows label="Design systems">
            {loaded.systems.map((each) => (
              <Row
                key={each.id}
                leading={<SystemThumb id={each.id} thumb={each.thumb} />}
                title={
                  <button
                    type="button"
                    className="cursor-pointer text-left font-medium text-fg-strong underline decoration-fg-dim decoration-dotted underline-offset-4 hover:decoration-solid"
                    onClick={() => {
                      if (each.id === builtIn) {
                        setPreviewed(true);
                      } else {
                        open({ artifact: each.id });
                      }
                    }}
                  >
                    {each.name}
                  </button>
                }
                description={summaryLine(each)}
              >
                {each.id === loaded.server && (
                  <Badge state="done">Team default</Badge>
                )}
                {each.id === loaded.mine && each.id !== loaded.server && (
                  <Badge state="done">My default</Badge>
                )}
                {(loaded.mine === null
                  ? each.id !== loaded.server
                  : each.id !== loaded.mine) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Make ${each.name} my default`}
                    onClick={() => {
                      put({
                        system: each.id === loaded.server ? null : each.id,
                      });
                    }}
                  >
                    Make my default
                  </Button>
                )}
              </Row>
            ))}
          </Rows>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                newSession(
                  "Make a design system from this repository's styles.",
                  [makeAttachment],
                );
              }}
            >
              Ask Pi to make one from a repo
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                newSession(
                  "Make a design system from the screenshot or URL I attach: ",
                  [makeAttachment],
                );
              }}
            >
              From a screenshot or URL
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-fg">
              When nothing is picked
            </span>
            <div className="w-fit max-w-full overflow-x-auto">
              <Segmented
                label="When nothing is picked"
                value={loaded.unpicked}
                options={(["default", "ask", "none"] as const).map((each) => ({
                  value: each,
                  label: unpickedLabels[each],
                }))}
                onChange={(unpicked) => {
                  put({ unpicked });
                }}
              />
            </div>
            <span className="text-caption text-fg-dim">
              When neither the Session nor your own default picks one.
            </span>
          </div>
          <ErrorText size="caption">{problem}</ErrorText>
        </div>
      )}
      <SystemPreview
        open={previewed}
        onClose={() => {
          setPreviewed(false);
        }}
      />
    </Section>
  );
}

// Settings › Artifacts, for admins: the team's design system, then the
// server's artifact settings.
export function ServerSettings(): ReactElement {
  const api = useApi(plugin);
  const { value, reload } = useSystems(true);
  const [problem, setProblem] = useState<string>();
  const loaded = value !== undefined && "systems" in value ? value : undefined;

  return (
    <>
      <Field
        label="Team design system"
        hint="Pi makes decks, canvases and pages with it for everyone without their own."
        error={
          problem ??
          (value !== undefined && "problem" in value
            ? `Couldn't load the design systems. ${value.problem}`
            : undefined)
        }
      >
        <Select
          value={loaded?.server ?? ""}
          disabled={loaded === undefined}
          onChange={(event) => {
            setProblem(undefined);

            void api
              .put("systems/server", { system: event.target.value })
              .then(reload)
              .catch((error: unknown) => {
                setProblem(errorText(error));
              });
          }}
        >
          {loaded === undefined && <option value="">Loading…</option>}
          {loaded?.systems.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="mt-6">
        <ConfigForm plugin={plugin} />
      </div>
    </>
  );
}

// Pipoca's own system, which is no artifact to open.
function SystemPreview({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);

  const { value, reload } = useLoaded(
    async () =>
      open
        ? api
            .get<SystemView>(`systems/${builtIn}`)
            .catch(() => "failed" as const)
        : undefined,
    open ? "system:pipoca" : "",
    { changes: ["artifacts"] },
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="full"
      title="Pipoca"
      description="Design system · Built in"
    >
      <DialogBody>
        {value === "failed" && (
          <ErrorText>The design system didn&apos;t load.</ErrorText>
        )}
        {value !== undefined && value !== "failed" && (
          <SystemBody view={value} version={undefined} onChanged={reload} />
        )}
      </DialogBody>
    </Dialog>
  );
}

type SystemTab =
  "overview" | "colors" | "type" | "spacing" | "components" | "users";

// A design system's page in the viewer (board L): its colors, type,
// spacing, components and the artifacts made with it.
export function SystemBody({
  view,
  version,
  onChanged,
}: {
  readonly view: SystemView;
  readonly version: number | undefined;
  readonly onChanged: () => void;
}): ReactElement {
  const [tab, setTab] = useState<SystemTab>("overview");
  const panelId = useId();

  const tabs: readonly { value: SystemTab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "colors", label: `Colors ${String(view.tokens.colors.length)}` },
    { value: "type", label: `Type ${String(view.tokens.type.length)}` },
    {
      value: "spacing",
      label: `Spacing ${String(view.tokens.spacing.length)}`,
    },
    {
      value: "components",
      label: `Components ${String(view.components.length)}`,
    },
    { value: "users", label: `Used by ${String(view.users.length)}` },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 md:px-5">
        <Tabs
          label="Sections"
          value={tab}
          tabs={tabs}
          panel={panelId}
          onSelect={setTab}
        />
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabPanelLabel(panelId, tab)}
        className="min-h-0 flex-1 overflow-y-auto bg-panel px-4 py-5 md:px-6"
      >
        {view.problems.length > 0 && (
          <ul
            aria-label="Problems in tokens.json"
            className="mb-4 flex flex-col gap-1 text-label text-fg-dim"
          >
            {view.problems.map((each) => (
              <li key={each}>{each}</li>
            ))}
          </ul>
        )}
        {tab === "overview" && (
          <div className="grid gap-5 md:grid-cols-2">
            <Card title="Colors">
              <Colors colors={view.tokens.colors.slice(0, 10)} />
            </Card>
            <Card title="Type">
              <TypeList styles={view.tokens.type.slice(0, 4)} />
            </Card>
            <Card
              title="Components"
              wide
              aside="each one a small page Pi and people can open"
            >
              <Components
                view={view}
                version={version}
                shown={view.components.slice(0, 4)}
              />
            </Card>
            <Defaults view={view} onChanged={onChanged} />
          </div>
        )}
        {tab === "colors" && (
          <Card title="Colors">
            <Colors colors={view.tokens.colors} usage />
          </Card>
        )}
        {tab === "type" && (
          <Card title="Type">
            <TypeList styles={view.tokens.type} usage />
          </Card>
        )}
        {tab === "spacing" && (
          <Card title="Spacing">
            <ul className="flex flex-col gap-2.5">
              {view.tokens.spacing.map((each) => (
                <li
                  key={each.name}
                  className="flex items-center gap-3 text-label"
                >
                  <span className="w-24 shrink-0 font-mono text-mono-sm text-fg-dim">
                    {each.name}
                  </span>
                  <span
                    aria-hidden
                    className="h-3 shrink-0 rounded-sm bg-accent"
                    style={{ width: each.value }}
                  />
                  <span className="text-fg">{each.value}</span>
                  {each.usage !== "" && (
                    <span className="min-w-0 truncate text-fg-dim">
                      {each.usage}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {tab === "components" && (
          <Card title="Components">
            <Components view={view} version={version} shown={view.components} />
          </Card>
        )}
        {tab === "users" && <Users view={view} />}
      </div>
    </div>
  );
}

function Card({
  title,
  aside,
  wide = false,
  children,
}: {
  readonly title: string;
  readonly aside?: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      aria-label={title}
      className={cn(
        cardClass,
        "flex min-w-0 flex-col gap-3 p-4.5",
        wide && "md:col-span-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3">
        <h3 className="flex-1 text-ui font-semibold text-fg-strong">{title}</h3>
        {aside !== undefined && (
          <span className="text-caption text-fg-dim">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Colors({
  colors,
  usage = false,
}: {
  readonly colors: SystemView["tokens"]["colors"];
  readonly usage?: boolean;
}): ReactElement {
  return colors.length === 0 ? (
    <p className="text-label text-fg-dim">No colors.</p>
  ) : (
    <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-5">
      {colors.map((each) => (
        <li
          key={each.name}
          className="flex min-w-0 flex-col gap-1 text-caption"
        >
          <span
            aria-hidden
            className="h-13 rounded-lg border border-line"
            style={{ background: each.value }}
          />
          <span className="truncate text-fg">{each.name}</span>
          <span className="truncate font-mono text-mono-sm text-fg-dim">
            {each.value}
          </span>
          {usage && each.usage !== "" && (
            <span className="text-fg-dim">{each.usage}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function TypeList({
  styles,
  usage = false,
}: {
  readonly styles: SystemView["tokens"]["type"];
  readonly usage?: boolean;
}): ReactElement {
  return styles.length === 0 ? (
    <p className="text-label text-fg-dim">No type styles.</p>
  ) : (
    <ul className="flex flex-col gap-2.5">
      {styles.map((each) => (
        <li key={each.name} className="flex min-w-0 flex-col gap-0.5">
          <span
            className="truncate text-fg-strong"
            style={{
              fontFamily: each.family === "" ? undefined : each.family,
              fontSize: each.size,
              lineHeight: each.lineHeight === "" ? 1.2 : each.lineHeight,
              fontWeight: each.weight === "" ? undefined : Number(each.weight),
              letterSpacing:
                each.letterSpacing === "" ? undefined : each.letterSpacing,
            }}
          >
            {usage && each.sample !== ""
              ? each.sample
              : [capital(each.name), familyName(each.family), each.size]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
          {usage && (
            <span className="text-caption text-fg-dim">
              {[
                each.name,
                each.size,
                ...(each.lineHeight === "" ? [] : [`line ${each.lineHeight}`]),
                ...(each.usage === "" ? [] : [each.usage]),
              ].join(" · ")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// The first font a family names, such as Georgia for Georgia, serif.
function familyName(family: string): string {
  return family.split(",")[0]?.replaceAll(/["']/g, "").trim() ?? "";
}

function capital(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

// The width a component's page is drawn at before it's shrunk to its tile.
const drawnWidth = 360;

function Components({
  view,
  version,
  shown,
}: {
  readonly view: SystemView;
  readonly version: number | undefined;
  readonly shown: readonly SystemComponent[];
}): ReactElement {
  const [opened, setOpened] = useState<SystemComponent>();

  return shown.length === 0 ? (
    <p className="text-label text-fg-dim">
      No components yet: each is a components/&lt;Name&gt;/preview.html.
    </p>
  ) : (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {shown.map((each) => (
          <li key={each.file} className="min-w-0">
            <button
              type="button"
              className="group flex w-full cursor-pointer flex-col gap-1.5 text-left"
              aria-label={`Open ${each.name}`}
              onClick={() => {
                setOpened(each);
              }}
            >
              <Preview
                src={systemFileSrc(view.id, version, each.file)}
                title={each.name}
              />
              <span className="truncate text-caption text-fg-dim group-hover:text-fg group-hover:underline">
                {each.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={opened !== undefined}
        onClose={() => {
          setOpened(undefined);
        }}
        size="lg"
        title={opened?.name ?? ""}
        description={opened?.file}
      >
        <DialogBody>
          {opened !== undefined && (
            <iframe
              title={opened.name}
              sandbox={frameSandbox}
              src={systemFileSrc(view.id, version, opened.file)}
              className="h-[60dvh] w-full rounded-md border border-line bg-canvas"
            />
          )}
        </DialogBody>
      </Dialog>
    </>
  );
}

// A component's page in its own sandboxed frame, shrunk to its tile.
function Preview({
  src,
  title,
}: {
  readonly src: string;
  readonly title: string;
}): ReactElement {
  const [measure, size] = useSize();
  const scale = size.width > 0 ? size.width / drawnWidth : 0.25;

  return (
    <span
      ref={measure}
      aria-hidden
      className="relative block h-28 overflow-hidden rounded-lg border border-line bg-canvas group-hover:border-fg-dim"
    >
      <iframe
        title={title}
        tabIndex={-1}
        loading="lazy"
        sandbox={frameSandbox}
        src={src}
        style={{
          width: `${String(drawnWidth)}px`,
          height: `${String(size.height > 0 ? size.height / scale : 384)}px`,
          transform: `scale(${String(scale)})`,
        }}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
      />
    </span>
  );
}

function Users({ view }: { readonly view: SystemView }): ReactElement {
  const { open } = useOverlay();

  return (
    <Card
      title="Used by"
      aside="each keeps its own copy until someone updates it"
    >
      {view.users.length === 0 ? (
        <p className="text-label text-fg-dim">
          Nothing you can see is made with it yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {view.users.map((each) => (
            <li key={each.id} className="border-t border-line first:border-t-0">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left hover:bg-hover"
                onClick={() => {
                  open({ artifact: each.id });
                }}
              >
                <span className="min-w-0 flex-1 truncate text-ui text-fg-strong">
                  {each.title}
                </span>
                <span className="text-caption text-fg-dim">
                  {[
                    typeLabel(each.type),
                    `copy of v${String(each.version)}`,
                    ...(each.version < view.version
                      ? [`v${String(view.version)} is newer`]
                      : []),
                  ].join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Who Pi makes things with it for: everyone without their own, by an
// admin, and the person.
function Defaults({
  view,
  onChanged,
}: {
  readonly view: SystemView;
  readonly onChanged: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const { person } = useViewer();
  const [problem, setProblem] = useState<string>();

  const put = (path: string, system: string | null): void => {
    setProblem(undefined);

    void api
      .put(path, { system })
      .then(onChanged)
      .catch((error: unknown) => {
        setProblem(errorText(error));
      });
  };

  return (
    <section
      aria-label="Default"
      className={cn(cardClass, "flex flex-col gap-3 p-4.5 md:col-span-2")}
    >
      {person.admin && (
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ui font-semibold text-fg-strong">
              Team default
            </span>
            <span className="text-label text-fg-dim">
              {view.server && view.id === builtIn
                ? "Pipoca's own is the team's default until you turn another system's on."
                : "Pi reads it before any deck, canvas or page, unless someone picks another."}
            </span>
          </div>
          <Switch
            label="Team default"
            labelHidden
            checked={view.server}
            disabled={view.server && view.id === builtIn}
            onChange={(on) => {
              put("systems/server", on ? view.id : null);
            }}
          />
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-semibold text-fg-strong">
            My default
          </span>
          <span className="text-label text-fg-dim">
            Pi uses it for your decks, canvases and pages instead of the
            team&apos;s.
          </span>
        </div>
        <Switch
          label="My default"
          labelHidden
          checked={view.mine}
          onChange={(on) => {
            put("systems/settings", on ? view.id : null);
          }}
        />
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
    </section>
  );
}

// Two versions of a system side by side, with what changed between them.
export function SystemCompare({
  id,
  from,
  to,
  changed,
}: {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  // What changed, else the tokens the two versions differ in.
  readonly changed?: readonly string[];
}): ReactElement {
  const api = useApi(plugin);

  const { value } = useLoaded(
    async () =>
      Promise.all(
        [from, to].map(async (v) =>
          api.get<SystemView>(`systems/${id}?v=${String(v)}`),
        ),
      ).catch(() => "failed" as const),
    `${id}:${String(from)}:${String(to)}:compare`,
  );

  const told =
    changed ??
    (value === undefined || value === "failed"
      ? []
      : changesOf(value[0]?.tokens ?? none, value[1]?.tokens ?? none, []));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-panel px-4 py-5 md:px-6">
      {told.length > 0 && (
        <p className="mb-4 text-label text-fg">
          {`v${String(to)} changed ${listed(told)}.`}
        </p>
      )}
      {value === "failed" && (
        <ErrorText>The versions didn&apos;t load.</ErrorText>
      )}
      {value !== undefined && value !== "failed" && (
        <div className="grid gap-5 md:grid-cols-2">
          {value.map((each, at) => {
            const version = at === 0 ? from : to;

            return (
              <section
                key={version}
                aria-label={`Version ${String(version)}`}
                className="flex min-w-0 flex-col gap-4"
              >
                <h3 className="text-ui font-semibold text-fg-strong">
                  Version {version}
                </h3>
                <Card title="Colors">
                  <Colors colors={each.tokens.colors} />
                </Card>
                <Card title="Type">
                  <TypeList styles={each.tokens.type} />
                </Card>
                <Card title="Components">
                  <Components
                    view={each}
                    version={version}
                    shown={each.components}
                  />
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const none: SystemView["tokens"] = { colors: [], type: [], spacing: [] };

function listed(names: readonly string[]): string {
  const shown = names.slice(0, 4);
  const more = names.length - shown.length;

  if (more > 0) {
    return `${shown.join(", ")} and ${String(more)} more`;
  }

  return shown.length < 2
    ? shown.join("")
    : `${shown.slice(0, -1).join(", ")} and ${String(shown.at(-1))}`;
}

// What the header's system button says about the copy an artifact keeps.
export function copyLine(artifact: ArtifactView, used: UsedSystem): string {
  const noun =
    { slides: "deck", canvas: "canvas" }[artifact.type as string] ?? "page";

  const kept = `This ${noun} has a copy of v${String(used.version)}.`;

  if (used.latest === null) {
    return `${kept} You don't see the system, so newer versions aren't shown.`;
  }

  if (used.latest <= used.version) {
    return `${kept} It's the latest.`;
  }

  return used.changed.length === 0
    ? `${kept} v${String(used.latest)} is newer.`
    : `${kept} v${String(used.latest)} changed ${listed(used.changed)}.`;
}

// The viewer header's button for an artifact made with a system (board M).
export function SystemButton({
  artifact,
  onCompare,
  onAsked,
  onFailed,
}: {
  readonly artifact: ArtifactView;
  readonly onCompare: () => void;
  readonly onAsked: (said: string) => void;
  readonly onFailed: (problem: string) => void;
}): ReactElement | null {
  const api = useApi(plugin);
  const { open } = useOverlay();
  const [switching, setSwitching] = useState(false);
  const [switches, setSwitches] = useState(0);
  const [previewed, setPreviewed] = useState(false);
  const used = artifact.designSystem;

  if (used === undefined) {
    return null;
  }

  const ask = (system: string, said: string): void => {
    void api
      .post(`artifacts/${artifact.id}/system`, { system })
      .then(() => {
        onAsked(said);
      })
      .catch((error: unknown) => {
        onFailed(errorText(error));
      });
  };

  const newer = used.latest !== null && used.latest > used.version;
  const name = shortName(used.name);

  const redraws =
    { slides: "slides", canvas: "boards" }[artifact.type as string] ?? "page";

  const unaskable = artifact.askable
    ? {}
    : {
        disabled: true,
        description: "Only people in its Session can ask Pi.",
      };

  const items: MenuItem[] = [
    {
      label: `Open ${used.name}`,
      description: copyLine(artifact, used),
      disabled: used.id !== builtIn && used.latest === null,
      run: () => {
        if (used.id === builtIn) {
          setPreviewed(true);
        } else {
          open({ artifact: used.id });
        }
      },
    },
    ...(newer
      ? [
          {
            label: `Update to v${String(used.latest)} (Pi redraws the ${redraws})`,
            divided: true,
            ...unaskable,
            run: () => {
              ask(used.id, `Pi is redrawing it with v${String(used.latest)}`);
            },
          },
          {
            label: `Compare v${String(used.version)} and v${String(used.latest)}`,
            run: onCompare,
          },
        ]
      : []),
    {
      label: "Switch to another system…",
      divided: !newer,
      ...unaskable,
      run: () => {
        setSwitches(switches + 1);
        setSwitching(true);
      },
    },
  ];

  return (
    <>
      <Menu
        label={`${name} v${String(used.version)}${newer ? `, v${String(used.latest)} is newer` : ""}. Design system`}
        variant="default"
        size="sm"
        align="end"
        trigger={
          <>
            {newer && (
              <span aria-hidden className="size-1.5 rounded-full bg-waiting" />
            )}
            <span className="max-w-32 truncate max-sm:hidden">{name}</span>
            <span>{`v${String(used.version)}`}</span>
            <Icon name="chevron-down" className="size-3.5" />
          </>
        }
        items={items}
      />
      <SwitchSystem
        key={switches}
        open={switching}
        current={used.id}
        session={artifact.sessionId}
        onClose={() => {
          setSwitching(false);
        }}
        onPick={(picked) => {
          setSwitching(false);
          ask(picked.id, `Pi is redrawing it with ${picked.name}`);
        }}
      />
      <SystemPreview
        open={previewed}
        onClose={() => {
          setPreviewed(false);
        }}
      />
    </>
  );
}

function SwitchSystem({
  open,
  current,
  session,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly current: string;
  // The Session whose Pi redraws it, which lists what it may use.
  readonly session: string | null;
  readonly onClose: () => void;
  readonly onPick: (system: SystemSummary) => void;
}): ReactElement {
  const { value } = useSystems(open, session ?? undefined);
  const [picked, setPicked] = useState<string>();

  const systems =
    value !== undefined && "systems" in value ? value.systems : [];

  const chosen = systems.find(({ id }) => id === (picked ?? current));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Switch to another system"
      description="Pi redraws it with the system you pick, as a new version."
    >
      <DialogBody>
        {value !== undefined && "problem" in value && (
          <ErrorText>{`Couldn't load the design systems. ${value.problem}`}</ErrorText>
        )}
        <SystemChoices
          systems={systems}
          value={chosen?.id}
          onChange={setPicked}
        />
      </DialogBody>
      <DialogFoot>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={chosen === undefined || chosen.id === current}
          onClick={() => {
            if (chosen !== undefined) {
              onPick(chosen);
            }
          }}
        >
          Ask Pi to switch
        </Button>
      </DialogFoot>
    </Dialog>
  );
}

function SystemChoices({
  systems,
  value,
  extra = [],
  onChange,
}: {
  readonly systems: readonly SystemSummary[];
  readonly value: string | undefined;
  readonly extra?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description: string;
  }[];
  readonly onChange: (id: string) => void;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label="Design systems"
      className="flex flex-col gap-2"
    >
      {[
        ...extra,
        ...systems.map((each) => ({
          id: each.id,
          title: each.name,
          description: summaryLine(each),
        })),
      ].map((each) => (
        <ChoiceCard
          key={each.id}
          name="system"
          value={each.id}
          checked={each.id === value}
          title={each.title}
          description={each.description}
          onChange={() => {
            onChange(each.id);
          }}
        />
      ))}
    </div>
  );
}

const defaultChoice = "default";

// What a Session uses when it picks nothing, as Settings says.
function fallbackLine(loaded: Systems): string {
  const named = (id: string): string | undefined =>
    loaded.systems.find((each) => each.id === id)?.name;

  const mine = loaded.mine === null ? undefined : named(loaded.mine);

  if (mine !== undefined) {
    return `Yours: ${mine}`;
  }

  if (loaded.unpicked === "default") {
    return `The team's: ${named(loaded.server) ?? "Pipoca"}`;
  }

  return `${unpickedLabels[loaded.unpicked]}, as your settings say`;
}

// The composer's + menu: the design system Pi makes this Session's decks,
// canvases and pages with.
export function PickSystem({ session }: SessionAttachProps): ReactElement {
  const api = useApi(plugin);
  const shown = useAttachOpen();
  const [picking, setPicking] = useState(false);
  const { value, reload } = useSystems(shown || picking, session.id);
  const [picked, setPicked] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const loaded = value !== undefined && "systems" in value ? value : undefined;
  const now = loaded?.session ?? defaultChoice;

  const current =
    now === "none"
      ? "none"
      : loaded?.systems.find(({ id }) => id === now)?.name;

  const save = (): void => {
    const system = picked ?? now;

    setProblem(undefined);

    void api
      .put("systems/session", {
        session: session.id,
        system: system === defaultChoice ? null : system,
      })
      .then(() => {
        reload();
        setPicking(false);
      })
      .catch((error: unknown) => {
        setProblem(errorText(error));
      });
  };

  return (
    <>
      <AttachRow
        icon="layout-grid"
        label={
          current === undefined
            ? "Design system…"
            : `Design system: ${shortName(current)}…`
        }
        onPick={() => {
          setPicked(undefined);
          setPicking(true);
        }}
      />
      <Dialog
        open={picking}
        onClose={() => {
          setPicking(false);
        }}
        size="md"
        title="Design system for this Session"
        description="Pi makes this Session's decks, canvases and pages with it. What it made keeps its copy."
      >
        <DialogBody>
          {value !== undefined && "problem" in value && (
            <ErrorText>{`Couldn't load the design systems. ${value.problem}`}</ErrorText>
          )}
          {loaded !== undefined && (
            <SystemChoices
              systems={loaded.systems}
              value={picked ?? now}
              extra={[
                {
                  id: defaultChoice,
                  title: "Use the default",
                  description: fallbackLine(loaded),
                },
                {
                  id: "none",
                  title: "None here",
                  description: "Pi writes its own styles in this Session.",
                },
              ]}
              onChange={setPicked}
            />
          )}
          <ErrorText size="caption">{problem}</ErrorText>
        </DialogBody>
        <DialogFoot>
          <Button
            variant="ghost"
            onClick={() => {
              setPicking(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={loaded === undefined}
            onClick={save}
          >
            Use it here
          </Button>
        </DialogFoot>
      </Dialog>
    </>
  );
}
