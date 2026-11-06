import {
  Button,
  ErrorText,
  Field,
  Page,
  PageTitle,
  Row,
  Rows,
  Switch,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../api";
import { usePlugins } from "../hooks";

export function TeamNaming({
  name,
}: {
  readonly name: string | null;
}): ReactElement {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const shown = draft ?? name ?? "";

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);

    api("settings.team.update", { body: { name: shown } }).then(
      () => {
        setError(undefined);
        setSaved(true);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Page>
      <PageTitle description="Shown on the team hub and in everyone's sidebar.">
        Name
      </PageTitle>
      <form onSubmit={save} className="flex max-w-md flex-col gap-4">
        <Field label="Team name" hint="Left empty, it shows as Team.">
          <TextInput
            value={shown}
            maxLength={60}
            placeholder="Team"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Save
          </Button>
          {saved && (
            <span role="status" className="text-label text-fg-dim">
              Saved
            </span>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
    </Page>
  );
}

// A plugin loads in team Sessions only if it says it works in team work and
// admins leave it on there (ADR 0067).
export function TeamPlugins(): ReactElement {
  const { value: plugins, reload } = usePlugins();
  const [error, setError] = useState<string>();

  const turn = (id: string, on: boolean): void => {
    api("plugins.update", {
      params: { plugin: id },
      body: { teamWork: on },
    }).then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Page>
      <PageTitle description="A plugin loads in team Sessions only if you leave it on. Built-in ones start on, installed ones start off. New team Sessions pick up a change.">
        Plugins in team work
      </PageTitle>
      <ErrorText className="mb-4">{error}</ErrorText>
      <Rows label="Plugins in team work">
        {plugins
          .filter(({ state }) => state === "on")
          .map(({ id, title, description, teamWork }) => (
            <Row key={id} title={title} description={description}>
              <Switch
                label={`${title} in team work`}
                labelHidden
                checked={teamWork}
                onChange={(on) => {
                  turn(id, on);
                }}
              />
            </Row>
          ))}
      </Rows>
    </Page>
  );
}
