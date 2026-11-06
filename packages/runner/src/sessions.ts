import type {
  Attempt,
  Log,
  Removal,
  RemovalReport,
  SessionStart,
} from "@pipoca/protocol";
import { removeWorkspace } from "@pipoca/workspaces";
import { reportRemoval } from "./client";
import { type Machine, type Running, startSession, workspaceDir } from "./host";

interface Hosted {
  readonly generation: number;
  readonly profileId: string;
  readonly session: Promise<Running | undefined>;
}

interface Unreported {
  readonly generation: number;
  readonly force: boolean;
  readonly report: RemovalReport;
}

// The Sessions the runner hosts, and the workspaces it removes, as the
// server's work asks.
interface HostedSessions {
  readonly start: (assignment: SessionStart) => void;
  readonly unload: (attempt: Attempt) => void;
  readonly remove: (removal: Removal) => void;
  readonly running: () => readonly Attempt[];
  readonly count: () => number;
  // Whether a Session, stopping ones included, may use the Profile.
  readonly usesProfile: (id: string) => boolean;
  // A process going down halts its Sessions before their tools, so a tool
  // cut off by it is recorded as interrupted when its Session next loads.
  readonly stopAll: (halt: boolean) => Promise<void>;
}

export function hostedSessions(machine: Machine, log: Log): HostedSessions {
  const hosted = new Map<string, Hosted>();
  const stopping = new Map<string, Promise<void>>();
  const removing = new Map<string, Promise<RemovalReport>>();
  // A second run of a removal finds its workspace gone and can't tell what it
  // held, so a report the server hasn't accepted is kept to send again.
  const unreported = new Map<string, Unreported>();

  const sessionLog =
    (sessionId: string): Log =>
    (message, fields) => {
      log(message, { sessionId, ...fields });
    };

  const retire = async (
    sessionId: string,
    entry: Hosted,
    halt = false,
  ): Promise<void> => {
    const stopped = (stopping.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const session = await entry.session;
        await (halt ? session?.halt() : session?.stop());
      })
      .catch((error: unknown) => {
        log("session failed to stop", { sessionId, error: String(error) });
      })
      .finally(() => {
        if (stopping.get(sessionId) === stopped) {
          stopping.delete(sessionId);
        }
      });

    stopping.set(sessionId, stopped);
    await stopped;
  };

  const release = (
    sessionId: string,
    generation: number,
  ): Hosted | undefined => {
    const entry = hosted.get(sessionId);
    if (entry?.generation !== generation) {
      return undefined;
    }

    hosted.delete(sessionId);

    return entry;
  };

  const host = async (
    assignment: SessionStart,
    attemptLog: Log,
  ): Promise<Running | undefined> => {
    const { sessionId, generation } = assignment;

    const current = (): boolean =>
      hosted.get(sessionId)?.generation === generation;

    await stopping.get(sessionId);

    const report =
      (await removing.get(sessionId)) ?? unreported.get(sessionId)?.report;

    if (!current()) {
      return undefined;
    }

    // An unarchive can overtake a removal or its report, so the assignment
    // may still name the workspace that removal deleted.
    const workspace = report?.restore ?? assignment.workspace;

    return startSession(
      machine,
      assignment,
      workspace,
      {
        current,
        fenced: () => {
          const entry = release(sessionId, generation);
          if (entry) {
            attemptLog("session fenced", { generation });
            void retire(sessionId, entry);
          }
        },
        release: () => release(sessionId, generation) !== undefined,
      },
      attemptLog,
    );
  };

  const removeSessionWorkspace = async (
    removal: Removal,
    removalLog: Log,
  ): Promise<RemovalReport> => {
    const { sessionId, generation, workspace, force } = removal;
    await stopping.get(sessionId);

    const held = unreported.get(sessionId);
    const again = held?.generation === generation && held.force === force;
    if (again) {
      removalLog("resending workspace removal report", { generation });
    }

    const report = again
      ? held.report
      : await removeWorkspace(
          workspace,
          {
            dir: workspaceDir(machine.dataDir, sessionId),
            force,
            folders: machine.folders,
          },
          removalLog,
        ).catch((error: unknown): RemovalReport => {
          removalLog("workspace removal failed", { error: String(error) });

          return { outcome: "kept", reason: String(error) };
        });

    unreported.set(sessionId, { generation, force, report });

    await reportRemoval(machine.agent, sessionId, {
      ...report,
      generation,
    }).then(
      () => {
        unreported.delete(sessionId);
      },
      (error: unknown) => {
        removalLog("workspace removal not reported", { error: String(error) });
      },
    );

    return report;
  };

  return {
    start: (assignment) => {
      const { sessionId } = assignment;

      const previous = hosted.get(sessionId);
      if (previous) {
        void retire(sessionId, previous);
      }

      hosted.set(sessionId, {
        generation: assignment.generation,
        profileId: assignment.profile.id,
        session: host(assignment, sessionLog(sessionId)),
      });
    },
    unload: ({ sessionId, generation }) => {
      const entry = release(sessionId, generation);
      if (entry) {
        void retire(sessionId, entry);
      }
    },
    remove: (removal) => {
      const { sessionId } = removal;
      if (removing.has(sessionId) || hosted.has(sessionId)) {
        return;
      }

      const removed = removeSessionWorkspace(
        removal,
        sessionLog(sessionId),
      ).finally(() => {
        removing.delete(sessionId);
      });

      removing.set(sessionId, removed);
    },
    running: () =>
      [...hosted].map(([sessionId, { generation }]) => ({
        sessionId,
        generation,
      })),
    count: () => hosted.size,
    usesProfile: (id) =>
      stopping.size > 0 ||
      [...hosted.values()].some(({ profileId }) => profileId === id),
    stopAll: async (halt) => {
      log("stopping sessions", { count: hosted.size, halt });

      await Promise.all(
        [...hosted].map(async ([sessionId, entry]) =>
          retire(sessionId, entry, halt),
        ),
      );

      await Promise.all([...stopping.values(), ...removing.values()]);
    },
  };
}
