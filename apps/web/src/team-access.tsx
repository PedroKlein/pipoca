import type { Session, SessionAccess } from "@pipoca/protocol";
import { Button, Icon, Picker, Segmented } from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { send } from "./api";
import { useTeammates } from "./hooks";

type Kind = SessionAccess["kind"];

// Whether the person may steer the Session, as the server decides it
// (ADR 0064).
export function steers(
  { ownedBy, access, startedBy }: Session,
  me: { readonly id: string; readonly admin: boolean },
): boolean {
  return (
    ownedBy !== "team" ||
    access.kind === "team" ||
    me.admin ||
    startedBy === me.id ||
    (access.kind === "named" && access.people.includes(me.id))
  );
}

export const accessLabels = {
  team: "Everyone steers",
  view: "View only",
  named: "Named people",
} as const satisfies Record<Kind, string>;

// Whoever started team work, or an admin, picks who else steers it.
export function AccessDialog({
  session,
  open,
  onClose,
}: {
  readonly session: Session;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="access-title"
      className="m-auto w-[min(480px,calc(100vw-32px))] overflow-visible rounded-xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/30 backdrop:backdrop-blur-[2px] open:animate-pop-in"
    >
      {open && <AccessForm session={session} onDone={onClose} />}
    </dialog>
  );
}

function AccessForm({
  session,
  onDone,
}: {
  readonly session: Session;
  readonly onDone: () => void;
}): ReactElement {
  const teammates = useTeammates();
  const [kind, setKind] = useState<Kind>(session.access.kind);

  const [people, setPeople] = useState<readonly string[]>(
    session.access.kind === "named" ? session.access.people : [],
  );

  const [error, setError] = useState<string>();

  const others = teammates.value.filter(({ id }) => id !== session.startedBy);
  const names = new Map(teammates.value.map(({ id, name }) => [id, name]));

  const save = (): void => {
    const access: SessionAccess =
      kind === "named" ? { kind, people } : { kind };

    send(
      `/api/sessions/${encodeURIComponent(session.id)}/access`,
      "PUT",
      access,
    )
      .then(onDone)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  };

  return (
    <form
      method="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-col gap-4 p-5"
    >
      <header className="flex items-center gap-2">
        <h2
          id="access-title"
          className="flex-1 text-ui font-semibold text-fg-strong"
        >
          Who steers this team work
        </h2>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onDone}>
          <Icon name="x" />
        </Button>
      </header>

      <Segmented
        label="Who steers"
        value={kind}
        onChange={setKind}
        options={(["team", "view", "named"] as const).map((value) => ({
          value,
          label: accessLabels[value],
        }))}
      />

      <p className="text-label text-fg-dim">
        {kind === "team" &&
          "Everyone on the team can follow it, send messages and stop it."}
        {kind === "view" &&
          "Everyone on the team can follow it. Only whoever started it, and admins, steer it."}
        {kind === "named" &&
          "Only whoever started it, the people you name, and admins see and steer it."}
      </p>

      {kind === "named" && (
        <Picker
          label="People"
          placeholder="Search people"
          multiple
          options={others.map(({ id, name }) => ({ value: id, label: name }))}
          selected={people}
          onChange={setPeople}
        >
          {people.length === 0
            ? "Pick people"
            : people.map((id) => names.get(id) ?? id).join(", ")}
        </Picker>
      )}

      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}

      <footer className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </footer>
    </form>
  );
}
