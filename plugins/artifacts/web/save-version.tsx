import { useApi } from "@pipoca/plugins/web";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView } from "../src/artifacts";

// Names a living doc's latest text as a version, such as Sent to legal
// (ADR 0082).
export function SaveVersionDialog({
  artifact,
  open,
  onSaved,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly open: boolean;
  readonly onSaved: (label: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Save version"
      description="Names the latest text as a version. Edits after it are still kept."
    >
      <SaveVersionForm
        artifact={artifact}
        onSaved={onSaved}
        onClose={onClose}
      />
    </Dialog>
  );
}

function SaveVersionForm({
  artifact,
  onSaved,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly onSaved: (label: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(undefined);

        void api
          .post(`artifacts/${artifact.id}/label`, { label })
          .then(() => {
            onSaved(label.trim());
          })
          .catch((error: unknown) => {
            setProblem(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <DialogBody>
        <Field label="Name" hint="Such as Sent to legal or Before the launch">
          <TextInput
            value={label}
            maxLength={80}
            required
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        </Field>
        <ErrorText size="caption">{problem}</ErrorText>
      </DialogBody>
      <DialogFoot>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || label.trim() === ""}
        >
          Save version
        </Button>
      </DialogFoot>
    </form>
  );
}
