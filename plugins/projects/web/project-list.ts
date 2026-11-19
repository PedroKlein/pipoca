import { useApi, useLoaded } from "@pipoca/plugins/web";
import type { TypedClient } from "@pipoca/plugins";
import { projects } from "../plugin";
import type { ProjectSummary } from "../src/model";

const watched = { topics: ["sessions"], changes: ["projects"] };

// The sidebar draws several parts from one list, so loads that start
// together share a request.
const loading = new Map<boolean, Promise<ProjectSummary[]>>();

// A person outside team work gets none of the team's.
async function teamList(api: TypedClient): Promise<ProjectSummary[]> {
  const response = await api.raw("team/projects");

  return response.ok ? ((await response.json()) as ProjectSummary[]) : [];
}

async function listOnce(
  api: TypedClient,
  team: boolean,
): Promise<ProjectSummary[]> {
  const found = loading.get(team);

  if (found !== undefined) {
    return found;
  }

  const started = team ? teamList(api) : api.get<ProjectSummary[]>("projects");
  loading.set(team, started);

  queueMicrotask(() => {
    loading.delete(team);
  });

  return started;
}

// A person's Projects, or the team's.
export function useProjectList(
  team: boolean,
): readonly ProjectSummary[] | undefined {
  const api = useApi(projects);

  return useLoaded(
    async () => listOnce(api, team),
    team ? "team-projects" : "projects",
    watched,
  ).value;
}
