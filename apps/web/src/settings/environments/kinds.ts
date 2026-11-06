import type { EnvironmentKind } from "@pipoca/protocol";

export function environmentsPath(team: boolean): string {
  return team ? "team/setup/environments" : "environments";
}

export const kindNames: Readonly<Record<EnvironmentKind, string>> = {
  machine: "Machines",
  docker: "Docker image",
  kubernetes: "Kubernetes",
};

export const kindAbout: Readonly<Record<EnvironmentKind, string>> = {
  machine:
    "Sessions run on the machines that join it, with what's installed there.",
  docker:
    "One container from its image on a machine that joins it, shared by its Sessions.",
  kubernetes:
    "Each person gets a pod on the cluster, which their Sessions share. There are no machines to connect: the server starts a pod when a Session needs one and stops it when it goes idle.",
};
