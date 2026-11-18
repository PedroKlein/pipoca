import { href as pageHref } from "@pipoca/plugins/web";
import { projects } from "../plugin";
import type { ProjectView } from "../src/model";

export const teamProjects = "projects";
export const teamAssistantPath = "team-assistant";

// Team Projects open only in the team's area, wherever the link came from.
export function link(path: string, team = false): string {
  return team
    ? `#team/plugin/${projects.id}/${teamProjects}/${path}`
    : pageHref(projects, path);
}

// Where a Project and the panel open in it live: a person's Team assistant
// under its own team entry, as a person's assistant is under theirs.
export function projectLink(
  project: Pick<ProjectView, "id" | "team" | "assistant">,
  rest: string,
): string {
  if (project.team && project.assistant) {
    return `#team/plugin/${projects.id}/${teamAssistantPath}/${rest}`;
  }

  return link(rest === "" ? project.id : `${project.id}/${rest}`, project.team);
}
