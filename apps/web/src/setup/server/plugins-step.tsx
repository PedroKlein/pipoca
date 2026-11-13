import type { PluginInfo } from "@pipoca/protocol";
import {
  Badge,
  Button,
  ErrorText,
  Field,
  initialsOf,
  Row,
  Rows,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../../data/client";
import { useAction, useQuery } from "../../data/hooks";
import { addsSetupStep } from "../../plugins";
import { PluginSwitch, turnPlugin } from "../../settings/plugins/plugin-card";
import {
  Restart,
  switchesAtRestart,
  waitsForRestart,
} from "../../settings/plugins/restart";

// The plugins installed on the server, those with a step of their own first,
// as Settings, Plugins turns them on and off (ADR 0072).
export function PluginsStep(): ReactElement {
  const plugins = useQuery("plugins.list").data ?? [];
  const [choosing, setChoosing] = useState(false);
  const withStep = plugins.filter(({ id }) => addsSetupStep(id));
  const others = plugins.filter(({ id }) => !addsSetupStep(id));

  return (
    <>
      {plugins.some(waitsForRestart) && <Restart />}
      <Group label="Adds a setup step">
        {withStep.map((plugin) => (
          <PluginRow key={plugin.id} plugin={plugin} plugins={plugins} />
        ))}
      </Group>
      <Group label="Works with no setup">
        {choosing ? (
          others.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} plugins={plugins} />
          ))
        ) : (
          <Row
            title={others.map(({ title }) => title).join(" · ")}
            description={`${String(others.filter(({ state }) => state === "on").length)} of ${String(others.length)} on`}
          >
            <Button
              size="sm"
              onClick={() => {
                setChoosing(true);
              }}
            >
              Choose
            </Button>
          </Row>
        )}
      </Group>
      <AddPlugin />
    </>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement | readonly ReactElement[];
}): ReactElement | null {
  if (Array.isArray(children) && children.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-caption text-fg-dim">{label}</h2>
      <Rows label={label}>{children}</Rows>
    </section>
  );
}

function PluginRow({
  plugin,
  plugins,
}: {
  readonly plugin: PluginInfo;
  readonly plugins: readonly PluginInfo[];
}): ReactElement {
  const [ask, asking] = useConfirm();

  const turn = useAction(async () => {
    await turnPlugin(plugin, plugins, ask);
  });

  return (
    <Row
      initials={initialsOf(plugin.title)}
      title={plugin.title}
      description={
        <>
          {plugin.description}
          <ErrorText size="caption">{turn.error ?? plugin.error}</ErrorText>
        </>
      }
    >
      {plugin.state === "failed" && <Badge state="failed">Failed</Badge>}
      {switchesAtRestart(plugin) && (
        <Badge state="waiting">
          {plugin.state === "on" ? "On" : "Off"} until restart
        </Badge>
      )}
      <PluginSwitch
        plugin={plugin}
        label={plugin.title}
        checked={plugin.turnedOn}
        onChange={() => {
          void turn.run();
        }}
      />
      {asking}
    </Row>
  );
}

// Installing only fetches the plugin; none of its code runs until it is
// turned on (ADR 0022).
function AddPlugin(): ReactElement {
  const [added, setAdded] = useState<string>();

  const install = useAction(async (form: HTMLFormElement) => {
    const url = new FormData(form).get("url");
    setAdded(undefined);

    const plugin = await request("plugins.install", {
      body: { url: typeof url === "string" ? url.trim() : "" },
    });

    setAdded(`Added ${plugin.title}, turned off. Turn it on above.`);
    form.reset();
  });

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void install.run(event.currentTarget);
  };

  return (
    <form onSubmit={submit} aria-label="Add a plugin">
      <Field
        label="Add a plugin"
        hint={
          added ?? "A git repository or a .tgz URL. It is added turned off."
        }
        error={install.error}
      >
        <div className="flex gap-2">
          <TextInput
            name="url"
            required
            placeholder="https://git.example.com/you/plugin.git#v1.0.0"
            className="flex-1 font-mono text-mono-sm"
          />
          <Button type="submit" disabled={install.pending}>
            {install.pending ? "Adding…" : "Add"}
          </Button>
        </div>
      </Field>
    </form>
  );
}
