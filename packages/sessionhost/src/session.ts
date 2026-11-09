import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, matchesGlob, sep } from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionServices,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  ExtensionRunner,
  hasTrustRequiringProjectResources,
  initTheme,
  type InlineExtension,
  type McpExtensionOptions,
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type ResourceDiagnostic,
  type Skill,
  SettingsManager,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import type { AgentOptions, Checkout, SessionLogins } from "@pipoca/plugins";
import type { ChildOptions } from "@pipoca/plugins/host";
import type {
  ModelRef,
  RegisteredProvider,
  StartAgent,
  ThinkingLevel,
} from "@pipoca/protocol";
import chalk from "chalk";
import { childTools } from "./children";
import type { Surfaces } from "./surfaces";
import type { RemoteUI } from "./ui";
import "./codemode";

interface ModelOptions {
  // The Pi agent folder: a Session's is its Profile's (ADR 0031).
  readonly agentDir: string;
  // The machine's own logins and custom models, shared by all its Profiles.
  readonly authPath: string;
  readonly modelsPath: string;
  readonly extensionPaths: readonly string[];
  readonly models?: {
    readonly runtime: ModelRuntime;
    readonly model: Model<Api>;
  };
}

export interface SessionOptions extends ModelOptions {
  readonly cwd: string;
  readonly checkouts?: readonly Checkout[];
  readonly sessionDir: string;
  readonly model?: ModelRef;
  readonly thinking?: ThinkingLevel;
  readonly systemPrompt?: string | null;
  readonly agent?: StartAgent;
  // Where the server's docs are (ADR 0052).
  readonly docsDir?: string;
  // The user's answer for the repository's own .pi, or null before anyone
  // was asked (ADR 0031).
  readonly trusted?: boolean | null;
}

export interface SessionHost {
  readonly ui: RemoteUI & Surfaces;
  readonly tools: readonly ToolDefinition[];
  readonly extensions: readonly InlineExtension[];
  readonly onError: (error: ExtensionError) => void;
  // Logins kept elsewhere than the machine's files (ADR 0045).
  readonly logins?: SessionLogins;
  // Opens a page, such as an MCP sign-in, where the person is.
  readonly openUrl?: (url: string) => void;
  // Finds the agent the Session starts as (ADR 0075).
  readonly agent?: (name: string) => Promise<AgentOptions>;
}

// As long as Pi's TUI gives a model list to load.
const refreshMs = 15_000;

// The tool that lets the model reach tools of each exposure it isn't
// declared with.
const finderOf: Partial<Record<ToolExposure, string>> = {
  deferred: "tool_search",
  codemode: "codemode",
};

// Pi turns these on by itself only for MCP servers whose tools need them. A
// resumed transcript or /tree restores the tools active back then, so they're
// turned on again after each.
function toolFinders(tools: readonly ToolDefinition[]): InlineExtension {
  const finders = new Set(
    tools.flatMap(({ exposure }) =>
      exposure === undefined ? [] : (finderOf[exposure] ?? []),
    ),
  );

  return {
    name: "tool-finders",
    factory: (pi) => {
      if (finders.size === 0) {
        return;
      }

      const activate = (): void => {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...finders])]);
      };

      pi.on("session_start", activate);
      pi.on("session_tree", activate);
    },
  };
}

// The extensions Pi's CLI builds in, so hosted sessions get the same tools.
// Its llama.cpp provider isn't exported, so it's left out.
function mcpOptions(host?: SessionHost): McpExtensionOptions {
  return {
    // Pi types the store as its own class, which it doesn't export. Its
    // extension calls only what McpLoginStore has.
    ...(host?.logins && {
      credentials: host.logins.mcp as unknown as NonNullable<
        McpExtensionOptions["credentials"]
      >,
    }),
    ...(host?.openUrl && { openUrl: host.openUrl }),
  };
}

function builtInExtensions(host?: SessionHost): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension() },
    { name: "tool-search", factory: createToolSearchExtension() },
    { name: "mcp", factory: createMcpExtension(mcpOptions(host)) },
  ].map((extension) => ({ ...extension, replaceable: true, builtin: true }));
}

function docsNote(dir: string): string {
  return `Pipoca runs this Session. Its docs are in ${dir}: pipoca/ for Pipoca, pi/ for Pi, and plugins/<id>/ for installed plugins. Read the relevant page there before writing a Pipoca or Pi format, such as a Profile, a plugin, a skill or an extension.`;
}

// The web chat folds tool calls away, so without this the user sees nothing
// until the turn's answer.
const talkNote =
  "The user follows this Session in a chat that shows your text and folds your tool calls away. Before your first tool call, say in one short sentence what you'll do. While you work, add a short line when you find something that matters or change course, not before every call. End the turn with the result.";

export async function startSession(
  options: SessionOptions,
  host?: SessionHost,
): Promise<AgentSession> {
  const cwd = await workingDirectory(options.cwd);

  // Pi's CLI sets the theme before any mode runs, and extensions style their
  // status text with it even when no terminal renders it.
  initTheme();

  // Pi styles bold and italic text with chalk, which leaves styles out without
  // a terminal. What extensions draw goes to the web and the Pi view.
  chalk.level = 3;

  const agent = await agentOf(options, host);

  // Added to what the Profile's APPEND_SYSTEM.md says, which Pi's
  // appendSystemPrompt would replace.
  const appended = [
    talkNote,
    ...[options.systemPrompt ?? "", agent?.systemPrompt ?? ""].filter(
      (prompt) => prompt !== "",
    ),
    ...(options.docsDir === undefined ? [] : [docsNote(options.docsDir)]),
  ];

  const services = await loadServices(cwd, options, {
    projectTrusted: options.trusted ?? !asksForTrust(cwd, options),
    appendSystemPromptOverride: (base: string[]) => [...base, ...appended],
    extensionFactories: [
      ...builtInExtensions(host),
      ...(agent && options.agent ? [agentTools(agent, options.agent)] : []),
      ...(host ? [toolFinders(host.tools)] : []),
      ...(host?.extensions ?? []),
    ],
    ...(host?.logins && { credentials: host.logins.models }),
  });

  try {
    const session = await sessionFrom(services, cwd, options, host, agent);

    childMcp.set(session, mcpOptions(host));

    return session;
  } catch (error) {
    await shutDown(services);

    throw error;
  }
}

async function sessionFrom(
  services: AgentSessionServices,
  cwd: string,
  options: SessionOptions,
  host: SessionHost | undefined,
  agent: AgentOptions | undefined,
): Promise<AgentSession> {
  const sessionManager = SessionManager.continueRecent(cwd, options.sessionDir);
  recordInterruptedToolCalls(sessionManager);

  // Pi restores the model and reasoning level a resumed session last used, so
  // the chosen ones only set the first.
  const fresh = sessionManager.buildSessionContext().messages.length === 0;

  const chosen = fresh
    ? await firstModel(services.modelRuntime, options, agent)
    : undefined;

  const thinking = agent?.thinking ?? chosen?.thinking ?? options.thinking;

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(host && { customTools: [...host.tools] }),
    ...(chosen?.model && { model: chosen.model }),
    ...(fresh && thinking && { thinkingLevel: thinking }),
  });

  await session.bindExtensions(
    host
      ? {
          uiContext: { ...session.extensionRunner.getUIContext(), ...host.ui },
          mode: "rpc",
          onError: host.onError,
        }
      : {},
  );

  refreshModels(services.modelRuntime);

  return session;
}

// The MCP logins a Session's children use, the same as its own.
const childMcp = new WeakMap<AgentSession, McpExtensionOptions>();

// A subagent's session (ADR 0057). It shares the parent's model runtime, so
// it reaches every model the parent can with the same logins, and keeps its
// file beside the parent's.
export async function startChild(
  parent: AgentSession,
  { agentDir, sessionDir }: Pick<SessionOptions, "agentDir" | "sessionDir">,
  child: ChildOptions,
): Promise<AgentSession> {
  const cwd = parent.sessionManager.getCwd();
  const children = join(sessionDir, "children");
  const { modelRuntime, settingsManager } = parent;

  const chosen =
    child.model === undefined
      ? { model: parent.model }
      : resolveCliModel({ cliModel: child.model, modelRuntime });

  if ("error" in chosen && chosen.error !== undefined) {
    throw new Error(chosen.error);
  }

  const { tools, extensionPaths, extensionFactories } = await childTools(
    parent,
    agentDir,
    child,
    childMcp.get(parent) ?? {},
  );

  const skills = child.skills ?? [];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [...extensionPaths],
    extensionFactories: [...extensionFactories],
    noSkills: skills.length === 0,
    ...(skills.length > 0 && {
      skillsOverride: (base: Parameters<typeof withoutHomeSkills>[0]) => {
        const kept = withoutHomeSkills(base);

        return {
          ...kept,
          skills: kept.skills.filter(({ name }) => skills.includes(name)),
        };
      },
    }),
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: withoutHomeContext,
    ...(child.systemPrompt !== undefined && {
      appendSystemPrompt: [child.systemPrompt],
    }),
  });

  await resourceLoader.reload();

  const { errors } = resourceLoader.getExtensions();
  if (errors.length > 0) {
    throw new Error(
      `extensions failed to load: ${errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`,
    );
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    tools: [...tools],
    ...(chosen.model && { model: chosen.model }),
    thinkingLevel:
      child.thinking ??
      ("thinkingLevel" in chosen ? chosen.thinkingLevel : undefined) ??
      parent.thinkingLevel,
    sessionManager:
      child.continueFrom !== undefined && existsSync(child.continueFrom)
        ? SessionManager.open(child.continueFrom, children)
        : SessionManager.create(cwd, children, {
            ...(parent.sessionFile !== undefined && {
              parentSession: parent.sessionFile,
            }),
          }),
  });

  if (extensionPaths.length > 0 || extensionFactories.length > 0) {
    await session.bindExtensions({});
  }

  return session;
}

// Pi's own sessions fetch the providers' model lists in the background once
// extensions have registered theirs, with the logins they have. Providers
// that list their models only this way, like SAP AI Core, have none
// otherwise. The lists are kept in the machine's models store for the
// runner to list.
export function refreshModels(
  runtime: ModelRuntime,
  providers?: readonly string[],
): void {
  void runtime
    .refresh({
      signal: AbortSignal.timeout(refreshMs),
      ...(providers && { providers: [...providers] }),
    })
    .catch(() => undefined);
}

// A repository's .pi can run code, so Pi loads it only once the user trusts
// the repository. Without anything there, there's nothing to ask.
export function asksForTrust(
  cwd: string,
  options: Pick<SessionOptions, "trusted">,
): boolean {
  return options.trusted === null && hasTrustRequiringProjectResources(cwd);
}

export interface ListedModels {
  readonly available: readonly ModelRef[];
  // The models of providers that extensions and models.json add, logged in
  // or not. Pi's own providers, over a thousand models, are left to /login
  // (ADR 0044).
  readonly registered: readonly ModelRef[];
  // Those providers, with or without models.
  readonly providers: readonly Pick<
    RegisteredProvider,
    "id" | "name" | "apiKey" | "oauth"
  >[];
}

// Pi rereads its auth file, so each call sees logins made since.
export async function modelLister(
  options: ModelOptions,
): Promise<() => Promise<ListedModels>> {
  const { modelRuntime } = await loadServices(homedir(), options);

  const piOwn = new Set(
    (
      await ModelRuntime.create({
        authPath: options.authPath,
        modelsPath: null,
        allowModelNetwork: false,
      })
    )
      .getProviders()
      .map(({ id }) => id),
  );

  const refs = (models: readonly ModelRef[]): readonly ModelRef[] =>
    models.map(({ provider, id }) => ({ provider, id }));

  return async () => {
    await modelRuntime.refresh({ allowNetwork: false });

    return {
      available: refs(await modelRuntime.getAvailable()),
      registered: refs(
        modelRuntime.getModels().filter(({ provider }) => !piOwn.has(provider)),
      ),
      providers: modelRuntime
        .getProviders()
        .filter(({ id }) => !piOwn.has(id))
        .map(({ id, name, auth }) => ({
          id,
          name,
          apiKey: auth.apiKey !== undefined,
          oauth: auth.oauth !== undefined,
        })),
    };
  };
}

// Services register the providers extensions add before the default model is
// resolved, as Pi's CLI does.
async function loadServices(
  cwd: string,
  options: ModelOptions,
  {
    projectTrusted = true,
    credentials,
    ...resources
  }: {
    readonly credentials?: CredentialStore;
    readonly projectTrusted?: boolean;
    readonly appendSystemPromptOverride?: (base: string[]) => string[];
    readonly extensionFactories?: InlineExtension[];
  } = {},
): Promise<AgentSessionServices> {
  const { agentDir } = options;

  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      ...resources,
      additionalExtensionPaths: [...options.extensionPaths],
      skillsOverride: withoutHomeSkills,
      agentsFilesOverride: withoutHomeContext,
    },
    modelRuntime:
      options.models?.runtime ??
      (await ModelRuntime.create({
        ...(credentials ? { credentials } : { authPath: options.authPath }),
        modelsPath: options.modelsPath,
      })),
  });

  const { errors } = services.resourceLoader.getExtensions();
  if (errors.length > 0) {
    await shutDown(services);
    const details = errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`extensions failed to load: ${details}`);
  }

  return services;
}

// Extensions run as they load, and some start work then, such as following
// the server until the session shuts down. A session that never starts tells
// them it shut down, or that work would outlive it.
async function shutDown(services: AgentSessionServices): Promise<void> {
  const { extensions, runtime } = services.resourceLoader.getExtensions();

  await new ExtensionRunner(
    extensions,
    runtime,
    services.cwd,
    SessionManager.inMemory(services.cwd),
    new ModelRegistry(services.modelRuntime),
  )
    .emit({ type: "session_shutdown", reason: "quit" })
    .catch(() => undefined);
}

// Pi always loads ~/.agents/skills as the user's own. Sessions take the
// user's setup from their Profile instead, so they behave the same on every
// machine (ADR 0031).
function withoutHomeSkills(base: {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const home = join(process.env["HOME"] ?? homedir(), ".agents", "skills");

  return {
    ...base,
    skills: base.skills.filter(
      ({ filePath }) => !filePath.startsWith(`${home}${sep}`),
    ),
  };
}

// Pi reads AGENTS.md and CLAUDE.md in every folder above the working
// directory, the home folder too when the workspace is under it.
function withoutHomeContext(base: {
  agentsFiles: { path: string; content: string }[];
}): { agentsFiles: { path: string; content: string }[] } {
  const home = process.env["HOME"] ?? homedir();

  return {
    agentsFiles: base.agentsFiles.filter(({ path }) => dirname(path) !== home),
  };
}

// The agent's model comes first, then the Session's, then the Profile's
// default (ADR 0075).
async function firstModel(
  runtime: ModelRuntime,
  options: SessionOptions,
  agent: AgentOptions | undefined,
): Promise<
  { readonly model?: Model<Api>; readonly thinking?: ThinkingLevel } | undefined
> {
  if (agent?.model !== undefined) {
    const chosen = resolveCliModel({
      cliModel: agent.model,
      modelRuntime: runtime,
    });

    if (chosen.error !== undefined) {
      throw new Error(chosen.error);
    }

    return {
      ...(chosen.model && { model: chosen.model }),
      ...(chosen.thinkingLevel && { thinking: chosen.thinkingLevel }),
    };
  }

  const model =
    options.model === undefined
      ? options.models?.model
      : await availableModel(runtime, options.model);

  return model && { model };
}

async function agentOf(
  options: SessionOptions,
  host: SessionHost | undefined,
): Promise<AgentOptions | undefined> {
  if (options.agent === undefined) {
    return undefined;
  }

  if (host?.agent === undefined) {
    throw new Error(
      `the Session starts as the agent ${options.agent.name}, but no plugin of it finds agents`,
    );
  }

  return host.agent(options.agent.name);
}

// The agent's tools limit Pi's, and the ones the Session's plugin keeps stay.
// A resumed transcript or /tree restores the tools active back then.
function agentTools(
  agent: AgentOptions,
  { keep }: StartAgent,
): InlineExtension {
  const wanted = (name: string): boolean =>
    keep.includes(name) ||
    agent.tools.some((tool) => tool === name || matchesGlob(name, tool));

  return {
    name: "agent-tools",
    factory: (pi) => {
      const limit = (): void => {
        pi.setActiveTools(
          pi
            .getAllTools()
            .map(({ name }) => name)
            .filter(wanted),
        );
      };

      pi.on("session_start", limit);
      pi.on("session_tree", limit);
    },
  };
}

export async function availableModel(
  runtime: ModelRuntime,
  { provider, id }: ModelRef,
): Promise<Model<Api>> {
  const find = async (): Promise<Model<Api> | undefined> =>
    (await runtime.getAvailable(provider)).find((m) => m.id === id);

  // A provider that lists its models only from the network, like SAP AI
  // Core, has none until the background refresh ends.
  const model =
    (await find()) ??
    (await runtime
      .refresh({
        providers: [provider],
        signal: AbortSignal.timeout(refreshMs),
      })
      .then(find, () => undefined));

  if (model === undefined) {
    throw new Error(`model not available: ${provider}/${id}`);
  }

  return model;
}

// Pi fills a missing tool result with "No result provided" when it builds the
// next request, which hides that the tool may have partly run before the crash.
function recordInterruptedToolCalls(sessionManager: SessionManager): void {
  const messages = sessionManager
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  const callIndex = messages.findLastIndex((m) => m.role === "assistant");
  const call = messages[callIndex];
  if (call?.role !== "assistant" || call.stopReason !== "toolUse") {
    return;
  }

  const answered = new Set(
    messages
      .slice(callIndex + 1)
      .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );

  for (const block of call.content) {
    if (block.type === "toolCall" && !answered.has(block.id)) {
      sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [
          {
            type: "text",
            text: "The tool was interrupted by a restart and may have partly run.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
}

async function workingDirectory(path: string): Promise<string> {
  const expanded =
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path;

  const found = isAbsolute(expanded)
    ? await stat(expanded).catch(() => undefined)
    : undefined;

  if (found?.isDirectory() !== true) {
    throw new Error(`working directory not found: ${path}`);
  }

  return expanded;
}

export async function stopSession(session: AgentSession): Promise<void> {
  await session.abort();

  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });

  session.dispose();
}
