import { Avatar, cn, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import { api } from "../api";
import { PluginBoundary } from "../plugin-boundary";
import { type NavEntry, pluginContext, pluginRoute } from "../plugins";

export function PluginNav({
  nav,
  route,
}: {
  readonly nav: readonly NavEntry[];
  readonly route: string;
}): ReactElement | null {
  const [pins, setPins] = useState<readonly string[]>();
  const [more, setMore] = useState(false);
  const page = pluginRoute(route);

  useEffect(() => {
    const pinnedAtFirst = nav.flatMap(({ name, pinned }) =>
      pinned ? [name] : [],
    );

    void api("me.pinnedPages")
      .then(({ pages }) => {
        setPins(pages ?? pinnedAtFirst);
      })
      .catch(() => {
        setPins(pinnedAtFirst);
      });
  }, [nav]);

  if (nav.length === 0 || pins === undefined) {
    return null;
  }

  const pin = (name: string, pinned: boolean): void => {
    const next = pinned
      ? [...pins, name]
      : pins.filter((known) => known !== name);

    setPins(next);

    api("me.pinnedPages.update", { body: { pages: next } }).catch(() => {
      setPins(pins);
    });
  };

  const pinned = nav.filter(({ name }) => pins.includes(name));
  const rest = nav.filter(({ name }) => !pins.includes(name));
  const showRest = more || rest.some(({ name }) => page?.name === name);

  const row = (entry: NavEntry, isPinned: boolean): ReactElement => (
    <div key={entry.name} className="flex flex-col gap-0.5">
      <div className="group/row relative">
        <a
          href={`#plugin/${entry.name}`}
          aria-current={route === `plugin/${entry.name}` ? "page" : undefined}
          className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
        >
          <Avatar
            name={entry.label}
            size="xs"
            square
            className="bg-elevated text-fg-dim group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
          >
            {entry.label.slice(0, 1).toUpperCase()}
          </Avatar>
          {entry.label}
        </a>
        <button
          type="button"
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${entry.label}`}
          aria-pressed={isPinned}
          onClick={() => {
            pin(entry.name, !isPinned);
          }}
          className={cn(
            "absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-fg-dim hover:bg-elevated hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100",
            isPinned
              ? "opacity-0 group-hover/row:opacity-100"
              : "opacity-60 group-hover/row:opacity-100",
          )}
        >
          <Icon
            name="pin"
            className={cn("size-3.5", isPinned && "fill-current")}
          />
        </button>
      </div>
      {entry.Items && (
        <PluginBoundary name={entry.name}>
          <entry.Items
            context={pluginContext(entry.name)}
            path={page?.name === entry.name ? page.path : undefined}
          />
        </PluginBoundary>
      )}
    </div>
  );

  return (
    <div id="plugin-nav" className="flex flex-col gap-0.5 px-2 pb-1">
      {pinned.map((item) => row(item, true))}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showRest}
            onClick={() => {
              setMore(!showRest);
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg-dim hover:bg-hover hover:text-fg"
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-md text-fg-dim"
            >
              <Icon name="more" />
            </span>
            {showRest ? "Less" : "More"}
          </button>
          {showRest && rest.map((item) => row(item, false))}
        </>
      )}
    </div>
  );
}
