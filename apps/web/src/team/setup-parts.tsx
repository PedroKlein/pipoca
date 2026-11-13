import {
  Button,
  buttonClass,
  ErrorText,
  Field,
  Icon,
  Page,
  plural,
  Row,
  Rows,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type HubPage, switchingWith } from "@pipoca/protocol";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import {
  alsoSwitched,
  PluginSwitch,
  switchQuestion,
} from "../settings/plugins/plugin-card";
import { navigate } from "../router";
import { AddPage } from "./add-page";
import { hrefOf, newPageId, pagesOf } from "./hub-pages";

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
      !(await ask(
        switchQuestion(
          `${title(id)} in team work`,
          [alsoSwitched(title(id), also.map(title), on)],
          on,
        ),
      ))
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
          .map((plugin) => (
            <Row
              key={plugin.id}
              title={plugin.title}
              description={plugin.description}
            >
              <PluginSwitch
                plugin={plugin}
                label={`${plugin.title} in team work`}
                checked={plugin.teamWork}
                onChange={(on) => {
                  void turn.run(plugin.id, on);
                }}
              />
            </Row>
          ))}
      </Rows>
      {asking}
    </Page>
  );
}

// The hub's pages in sidebar order. Home always comes first and stays.
export function HubLayout(): ReactElement {
  const pages = pagesOf(useQuery("settings.hub").data?.pages ?? null);
  const [ask, asking] = useConfirm();

  const lay = useAction(async (next: readonly HubPage[]) =>
    request("settings.hub.update", { body: { pages: next } }),
  );

  const move = (from: number, to: number): void => {
    const next = [...pages];
    const [page] = next.splice(from, 1);

    if (page !== undefined) {
      next.splice(to, 0, page);
      void lay.run(next);
    }
  };

  const remove = async (page: HubPage): Promise<void> => {
    if (
      await ask({
        title: `Remove ${page.title}?`,
        description: "Its panels stay available to place on other pages.",
        confirm: "Remove",
        danger: true,
      })
    ) {
      void lay.run(pages.filter((each) => each.id !== page.id));
    }
  };

  return (
    <Page
      title="Hub layout"
      description="The pages under More in everyone's team sidebar, and the panels on each. Open a page to place its panels."
    >
      <ErrorText className="mb-4">{lay.error}</ErrorText>
      <Rows label="Hub pages">
        {pages.map((page, index) => {
          const home = index === 0;

          return (
            <Row
              key={page.id}
              title={home ? "Home" : page.title}
              description={plural(page.panels.length, "panel")}
            >
              <div className="ml-auto flex items-center gap-1">
                {!home && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${page.title} up`}
                      disabled={index === 1}
                      onClick={() => {
                        move(index, index - 1);
                      }}
                    >
                      <Icon name="arrow-up" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${page.title} down`}
                      disabled={index === pages.length - 1}
                      onClick={() => {
                        move(index, index + 1);
                      }}
                    >
                      <Icon name="arrow-up" className="rotate-180" />
                    </Button>
                  </>
                )}
                <a href={hrefOf(page)} className={buttonClass({ size: "sm" })}>
                  Open
                </a>
                {!home && (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${page.title}`}
                    onClick={() => {
                      void remove(page);
                    }}
                  >
                    <Icon name="trash" />
                  </Button>
                )}
              </div>
            </Row>
          );
        })}
      </Rows>
      <div className="mt-3">
        <AddPage
          onAdd={(title) => {
            const page = { id: newPageId(title, pages), title, panels: [] };

            void lay.run([...pages, page]);
            navigate(hrefOf(page));
          }}
        />
      </div>
      {asking}
    </Page>
  );
}
