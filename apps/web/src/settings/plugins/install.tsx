import { Button, ErrorText, Section, TextInput } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";

// Installing only fetches the plugin; none of its code runs until it is
// turned on (ADR 0022).
export function Install({
  onInstalled,
  onClose,
}: {
  readonly onInstalled: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<string>();
  const [installing, setInstalling] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const form = event.currentTarget;
    const url = new FormData(form).get("url");

    setInstalling(true);
    setInstalled(undefined);

    api("plugins.install", {
      body: { url: typeof url === "string" ? url.trim() : "" },
    })
      .then(
        (plugin) => {
          setError(undefined);

          setInstalled(
            `Installed ${plugin.title}, turned off. It's listed below.`,
          );

          form.reset();
          onInstalled();
        },
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        setInstalling(false);
      });
  };

  return (
    <Section
      title="Install a plugin"
      description="It installs turned off, so none of its code runs yet"
    >
      <form
        onSubmit={submit}
        aria-label="Install a plugin"
        className="flex flex-col gap-2"
      >
        <label className="sr-only" htmlFor="plugin-url">
          Install from a git repository or a .tgz URL
        </label>
        <div className="flex gap-2">
          <TextInput
            id="plugin-url"
            name="url"
            required
            placeholder="https://github.com/you/plugin.git#v1.0.0"
            className="flex-1 font-mono text-mono-sm"
          />
          <Button variant="primary" type="submit" disabled={installing}>
            {installing ? "Installing…" : "Install"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="text-caption text-fg-dim">
          A git repository or a .tgz URL. A branch, tag or commit after # pins
          it.
        </p>
        <ErrorText size="caption">{error}</ErrorText>
        {installed !== undefined && (
          <p role="status" className="text-caption text-fg-dim">
            {installed}
          </p>
        )}
      </form>
    </Section>
  );
}
