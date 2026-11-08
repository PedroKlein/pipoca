import {
  Button,
  ErrorText,
  Field,
  Page,
  Row,
  Rows,
  Switch,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { switchingWith } from "@pipoca/protocol";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import { alsoSwitched } from "../settings/plugins/plugin-card";

export function TeamNaming(): ReactElement {
  const name = useQuery("settings.team").data?.name;
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState(false);
  const shown = draft ?? name ?? "";

  const rename = useAction(async (to: string) => {
    await request("settings.team.update", { body: { name: to } });
    setSaved(true);
  });

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);
    void rename.run(shown);
  };

  return (
    <Page
      title="Name"
      description="Shown on the team hub and in everyone's sidebar."
    >
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
        <ErrorText>{rename.error}</ErrorText>
      </form>
    </Page>
  );
}

// A plugin loads in team Sessions only if it says it works in team work and
// admins leave it on there (ADR 0067).
export function TeamPlugins(): ReactElement {
  const plugins = useQuery("plugins.list").data ?? [];

  const [ask, asking] = useConfirm();

  const turn = useAction(async (id: string, on: boolean) => {
    const title = (other: string): string =>
      plugins.find((each) => each.id === other)?.title ?? other;

    const also = switchingWith(
      plugins,
      id,
      on,
      (other) => plugins.find((each) => each.id === other)?.teamWork === true,
    );

    if (
      also.length > 0 &&
      !(await ask({
        title: `Turn ${on ? "on" : "off"} ${title(id)} in team work?`,
        description: alsoSwitched(title(id), also.map(title), on),
        confirm: on ? "Turn on" : "Turn off",
      }))
    ) {
      return;
    }

    await request("plugins.update", {
      params: { plugin: id },
      body: { teamWork: on },
    });
  });

  return (
    <Page
      title="Plugins in team work"
      description="A plugin loads in team Sessions only if you leave it on. Built-in ones start on, installed ones start off. New team Sessions pick up a change."
    >
      <ErrorText className="mb-4">{turn.error}</ErrorText>
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
                  void turn.run(id, on);
                }}
              />
            </Row>
          ))}
      </Rows>
      {asking}
    </Page>
  );
}
