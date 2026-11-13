import type { ThinkingLevel, WorkspaceRequest } from "@pipoca/protocol";

// The New session composer remembers its last choices in this browser, like
// Claude Code's (ADR 0040).
export interface Choices {
  readonly environment: string;
  readonly where: readonly string[];
  readonly share: boolean;
  readonly model: string;
  readonly thinking: ThinkingLevel | "";
  readonly profile: string;
}

// Team work keeps its own, since it runs on the team's Environments.
function choicesKey(team: boolean): string {
  return team ? "pipoca.new-team-work" : "pipoca.new-session";
}

const fresh: Choices = {
  environment: "",
  where: [],
  share: false,
  model: "",
  thinking: "",
  profile: "",
};

export function remembered(team: boolean): Choices {
  try {
    const saved = localStorage.getItem(choicesKey(team));

    return saved === null
      ? fresh
      : { ...fresh, ...(JSON.parse(saved) as Partial<Choices>) };
  } catch {
    return fresh;
  }
}

export function remember(choices: Choices, team: boolean): void {
  try {
    localStorage.setItem(choicesKey(team), JSON.stringify(choices));
  } catch {
    // The choices only last this visit.
  }
}

export function isRepository(where: string): boolean {
  return where.includes("://") || /^[\w.-]+@[\w.-]+:/.test(where);
}

export function lastSegment(where: string): string {
  return (
    where
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .at(-1)
      ?.replace(/\.git$/, "") ?? where
  );
}

// The workspace kind follows from what was picked (ADR 0040).
export function workspaceRequest(
  where: readonly string[],
  share: boolean,
  startPoint: string,
): WorkspaceRequest {
  const [only] = where;

  const from = startPoint === "" ? {} : { startPoint };

  if (where.length === 1 && only !== undefined) {
    if (isRepository(only)) {
      return { kind: "clone", repository: only, ...from };
    }

    return { kind: share ? "folder" : "worktree", path: only, ...from };
  }

  return {
    kind: "repositories",
    repositories: where.map((repository) => ({ repository, ...from })),
  };
}
