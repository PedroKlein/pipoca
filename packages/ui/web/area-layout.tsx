import type { ReactElement, ReactNode } from "react";
import { cardClass } from "./card";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export interface AreaItem {
  readonly href: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly current?: boolean;
  // A number at the end of the line, such as how many there are.
  readonly count?: number;
}

export interface AreaGroup {
  readonly label?: string;
  readonly items: readonly AreaItem[];
}

const itemClass =
  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-medium aria-[current=page]:text-fg-strong";

// An area with its own side nav, such as Settings, the Team hub and Team
// setup: a link back, a serif heading, groups of pages, then the page.
//
// On a phone the nav either becomes a menu page of its own ("menu", shown
// while menuOpen) or a row of links above the page ("bar").
export function AreaLayout({
  label,
  back,
  heading,
  mark,
  detail,
  groups,
  footer,
  phone = "bar",
  menuOpen = false,
  menuHref,
  menuTop,
  fill = false,
  children,
}: {
  readonly label: string;
  readonly back: { readonly href: string; readonly label: string };
  readonly heading: string;
  // A square before the heading, such as the team's initial.
  readonly mark?: ReactNode;
  // A line under the heading, such as how many people there are.
  readonly detail?: ReactNode;
  readonly groups: readonly AreaGroup[];
  // More at the end of the nav, such as an Add button.
  readonly footer?: ReactNode;
  readonly phone?: "menu" | "bar";
  readonly menuOpen?: boolean;
  // Where a phone goes back to the menu from a page.
  readonly menuHref?: string;
  // A card at the top of the phone menu, such as the person's own.
  readonly menuTop?: ReactNode;
  // The page fills the area and scrolls itself, such as a Session.
  readonly fill?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const bar = phone === "bar";

  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <nav
        aria-label={label}
        className={cn(
          "flex w-58 shrink-0 flex-col gap-px overflow-y-auto border-r border-line bg-panel px-3 pt-4 pb-6",
          bar
            ? "max-md:w-full max-md:flex-row max-md:flex-wrap max-md:items-center max-md:border-r-0 max-md:border-b max-md:py-2"
            : "max-md:hidden",
        )}
      >
        <a
          href={back.href}
          className="mb-2.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-label text-fg-dim hover:bg-hover max-md:mb-0"
        >
          <Icon name="chevron-left" />
          {back.label}
        </a>
        <div className="flex items-center gap-2.5 px-2.5 pt-0.5 pb-1.5 max-md:hidden">
          {mark}
          <div className="min-w-0">
            <h2 className="truncate font-serif text-wordmark font-light text-fg-strong">
              {heading}
            </h2>
            {detail !== undefined && (
              <p className="mt-1 text-caption text-fg-dim">{detail}</p>
            )}
          </div>
        </div>
        {groups
          .filter(({ items }) => items.length > 0)
          .map((group, index) => (
            <div
              key={group.label ?? index}
              className="flex flex-col gap-px max-md:contents"
            >
              {group.label !== undefined && (
                <h3 className="px-2.5 pt-4 pb-1 text-caption text-fg-dim max-md:hidden">
                  {group.label}
                </h3>
              )}
              {group.items.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={item.current === true ? "page" : undefined}
                  className={itemClass}
                >
                  {item.icon !== undefined && <Icon name={item.icon} />}
                  <span className="flex-1">{item.label}</span>
                  {item.count !== undefined && (
                    <span className="text-caption text-fg-dim tabular-nums">
                      {item.count}
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
        {footer}
      </nav>
      {!bar && menuOpen && (
        <PhoneMenu
          back={back}
          heading={heading}
          groups={groups}
          top={menuTop}
        />
      )}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1",
          fill ? "flex flex-col" : "overflow-y-auto",
          !bar && menuOpen && "max-md:hidden",
        )}
      >
        {!bar && menuHref !== undefined && (
          <a
            href={menuHref}
            aria-label={`Back to ${heading}`}
            className="m-2 inline-flex size-touch items-center justify-center rounded-md text-fg hover:bg-hover md:hidden"
          >
            <Icon name="chevron-left" />
          </a>
        )}
        {children}
      </div>
    </div>
  );
}

function PhoneMenu({
  back,
  heading,
  groups,
  top,
}: {
  readonly back: { readonly href: string; readonly label: string };
  readonly heading: string;
  // A square before the heading, such as the team's initial.
  readonly mark?: ReactNode;
  readonly groups: readonly AreaGroup[];
  readonly top: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 md:hidden">
      <header className="flex items-center gap-2 pt-3.5 pb-1.5">
        <a
          href={back.href}
          aria-label={back.label}
          className="-ml-3 inline-flex size-touch items-center justify-center rounded-md text-fg hover:bg-hover"
        >
          <Icon name="chevron-left" />
        </a>
        <h1 className="font-serif text-display font-light text-fg-strong">
          {heading}
        </h1>
      </header>
      {top}
      {groups
        .filter(({ items }) => items.length > 0)
        .map((group, index) => (
          <section key={group.label ?? index} className="flex flex-col">
            {group.label !== undefined && (
              <h2 className="px-1 pt-3 pb-1 text-caption text-fg-dim">
                {group.label}
              </h2>
            )}
            <ul className={cn("flex flex-col", cardClass)}>
              {group.items.map((item) => (
                <li
                  key={item.href}
                  className="border-t border-line first:border-t-0"
                >
                  <a
                    href={item.href}
                    className="flex min-h-12 items-center gap-3 px-4 text-ui font-medium text-fg-strong"
                  >
                    <span className="flex-1">{item.label}</span>
                    <Icon name="chevron-right" className="text-fg-dim" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
