import { Button, cn, Icon, type IconName, SidePanel } from "@pipoca/ui";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Section {
  readonly name: string;
  readonly order: number;
  readonly label: string;
  readonly icon: IconName;
  readonly button: string;
  readonly badge: string | undefined;
  readonly waiting: boolean;
  readonly detailed: boolean;
}

interface Panel {
  readonly open: boolean;
  // The section whose detail shows, or undefined for every summary.
  readonly view: string | undefined;
  readonly bodies: ReadonlyMap<string, HTMLElement>;
  readonly show: (open: boolean, view?: string) => void;
  readonly add: (section: Section) => () => void;
}

interface Host {
  readonly sections: readonly Section[];
  readonly panel: Panel;
  // The rail button to focus once the panel closes, by its section's name,
  // or "" for the rail's own.
  readonly closedFrom: string | undefined;
  readonly body: (element: HTMLElement | null) => (() => void) | undefined;
}

const PanelContext = createContext<Panel | undefined>(undefined);
const HostContext = createContext<Host | undefined>(undefined);

// The header's button, which takes focus back on a small screen.
const ButtonContext = createContext<RefObject<HTMLButtonElement | null>>({
  current: null,
});

const storageKey = "pipoca.session-panel";
const wide = "(min-width: 64rem)";

function storedOpen(): boolean {
  try {
    return (
      localStorage.getItem(storageKey) === "open" && matchMedia(wide).matches
    );
  } catch {
    return false;
  }
}

function storeOpen(open: boolean): void {
  try {
    localStorage.setItem(storageKey, open ? "open" : "closed");
  } catch {
    // It stays this way until the page reloads.
  }
}

// One panel beside a Session that holds what every plugin shows about it
// (ADR 0084). Closed, it is a rail of the sections' icons with their
// badges; open, it lists their summaries or one section's detail. The app
// draws it around a Session's view, in a flex row.
export function SessionPanel({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [sections, setSections] = useState<readonly Section[]>([]);
  const [open, setOpen] = useState(storedOpen);
  const [view, setView] = useState<string>();
  const [closedFrom, setClosedFrom] = useState<string>();
  const button = useRef<HTMLButtonElement>(null);

  const [bodies, setBodies] = useState<ReadonlyMap<string, HTMLElement>>(
    new Map(),
  );

  const add = useCallback((section: Section) => {
    setSections((now) => [
      ...now.filter(({ name }) => name !== section.name),
      section,
    ]);

    return () => {
      setSections((now) => now.filter(({ name }) => name !== section.name));
    };
  }, []);

  const show = useCallback(
    (next: boolean, name?: string) => {
      setClosedFrom(next ? undefined : (view ?? ""));
      setOpen(next);
      setView(name);
      storeOpen(next);
    },
    [view],
  );

  const body = useCallback((element: HTMLElement | null) => {
    const key = element?.dataset["body"];

    if (key === undefined || element === null) {
      return undefined;
    }

    setBodies((now) => new Map(now).set(key, element));

    return () => {
      setBodies((now) => {
        const next = new Map(now);

        next.delete(key);

        return next;
      });
    };
  }, []);

  const sorted = useMemo(
    () => [...sections].sort((a, b) => a.order - b.order),
    [sections],
  );

  const shown = sorted.find(({ name }) => name === view);

  const panel = useMemo(
    () => ({ open, view: shown?.name, bodies, show, add }),
    [open, shown, bodies, show, add],
  );

  const host = useMemo(
    () => ({ sections: sorted, panel, closedFrom, body }),
    [sorted, panel, closedFrom, body],
  );

  return (
    <HostContext value={host}>
      <ButtonContext value={button}>
        <PanelContext value={panel}>
          {children}
          {open ? <Open shown={shown} /> : <Rail />}
        </PanelContext>
      </ButtonContext>
    </HostContext>
  );
}

function Open({
  shown,
}: {
  readonly shown: Section | undefined;
}): ReactElement | null {
  const { sections, panel, body } = useHost();

  return (
    <SidePanel
      open
      docked
      title={shown?.label ?? "Session"}
      closeLabel="Close panel"
      size={shown === undefined ? "sm" : "lg"}
      onClose={() => {
        panel.show(false);
      }}
    >
      {shown === undefined ? (
        <div className="flex flex-col divide-y divide-line">
          {sections.map((section) => (
            <section
              key={section.name}
              aria-label={section.label}
              className="flex flex-col gap-2 py-3 first:pt-0"
            >
              <h3 className="flex items-center gap-2 text-caption font-semibold tracking-wide text-fg-dim uppercase">
                <Icon name={section.icon} className="size-3.5" />
                {section.detailed ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 uppercase hover:text-fg-strong"
                    onClick={() => {
                      panel.show(true, section.name);
                    }}
                  >
                    {section.label}
                    <Icon name="chevron-right" className="size-3" />
                  </button>
                ) : (
                  section.label
                )}
                {section.badge !== undefined && (
                  <Count waiting={section.waiting}>{section.badge}</Count>
                )}
              </h3>
              <div
                ref={body}
                data-body={`summary:${section.name}`}
                className="flex flex-col gap-1 text-label"
              />
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => {
              panel.show(true);
            }}
          >
            <Icon name="chevron-left" className="size-3.5" />
            All of this Session
          </Button>
          <div ref={body} data-body="detail" className="flex flex-col gap-6" />
        </div>
      )}
    </SidePanel>
  );
}

function Rail(): ReactElement | null {
  const { sections, panel, closedFrom } = useHost();
  const button = useContext(ButtonContext);
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    if (closedFrom === undefined) {
      return;
    }

    if (!matchMedia(wide).matches) {
      button.current?.focus();

      return;
    }

    rail.current
      ?.querySelector<HTMLButtonElement>(`button[data-section="${closedFrom}"]`)
      ?.focus();
  }, [closedFrom, button]);

  if (sections.length === 0) {
    return null;
  }

  return (
    <nav
      ref={rail}
      aria-label="Session panel"
      className="hidden w-11 shrink-0 flex-col items-center gap-1 border-l border-line py-2 lg:flex"
    >
      <Button
        variant="ghost"
        iconOnly
        aria-label="Open panel"
        data-section=""
        onClick={() => {
          panel.show(true);
        }}
      >
        <Icon name="panel-right" />
      </Button>
      {sections.map((section) => (
        <Button
          key={section.name}
          variant="ghost"
          iconOnly
          className="relative"
          aria-label={section.button}
          data-section={section.name}
          title={section.label}
          onClick={() => {
            panel.show(true, section.detailed ? section.name : undefined);
          }}
        >
          <Icon name={section.icon} />
          {section.badge !== undefined && (
            <Count waiting={section.waiting} floating>
              {section.badge}
            </Count>
          )}
        </Button>
      ))}
    </nav>
  );
}

function Count({
  waiting,
  floating = false,
  children,
}: {
  readonly waiting: boolean;
  readonly floating?: boolean;
  readonly children: string;
}): ReactElement {
  return (
    <span
      aria-hidden={floating}
      className={cn(
        "rounded-full px-1 text-center text-[10px] leading-[14px] font-semibold tracking-normal tabular-nums",
        waiting ? "bg-waiting text-white" : "bg-fg text-bg",
        floating && "absolute -top-0.5 -right-1 min-w-3.5",
        children === "" && "size-2 min-w-0 p-0",
      )}
    >
      {children}
    </span>
  );
}

// The header's button that opens the panel on a small screen, where there
// is no rail, with a dot when a section needs the person.
export function SessionPanelButton(): ReactElement | null {
  const host = useContext(HostContext);
  const button = useContext(ButtonContext);

  if (host === undefined || host.sections.length === 0) {
    return null;
  }

  const waiting = host.sections.some((section) => section.waiting);

  return (
    <span className="lg:hidden">
      <Button
        ref={button}
        variant="ghost"
        iconOnly
        className="relative"
        aria-label={waiting ? "Open panel, something needs you" : "Open panel"}
        aria-expanded={host.panel.open}
        onClick={() => {
          host.panel.show(!host.panel.open);
        }}
      >
        <Icon name="panel-right" />
        {waiting && (
          <span className="absolute top-1 right-1 size-2 rounded-full bg-waiting" />
        )}
      </Button>
    </span>
  );
}

// A plugin's section of its Session's panel: an icon on the rail with its
// badge, a summary in the open panel, and a detail its title or icon opens.
// Not drawing one leaves the plugin out of the panel.
export function SessionSection({
  name,
  order,
  label,
  icon,
  button,
  badge,
  waiting = false,
  detail,
  children,
}: {
  readonly name: string;
  // Where it sits, lowest first: Files 10, Changes 20, Subagents 30,
  // Votes 40, About 90.
  readonly order: number;
  readonly label: string;
  readonly icon: IconName;
  // The rail button's accessible name, such as "Diff, 3 files changed".
  readonly button: string;
  // A count or a few characters, such as "+48"; "" draws a dot.
  readonly badge?: string;
  // The section needs the person, such as an open vote.
  readonly waiting?: boolean;
  readonly detail?: ReactNode;
  readonly children: ReactNode;
}): ReactElement | null {
  const panel = useContext(PanelContext);

  if (panel === undefined) {
    throw new Error("SessionSection needs a SessionPanel around the Session");
  }

  const { add, open, view, bodies } = panel;
  const detailed = detail !== undefined;

  useEffect(
    () => add({ name, order, label, icon, button, badge, waiting, detailed }),
    [add, name, order, label, icon, button, badge, waiting, detailed],
  );

  if (!open) {
    return null;
  }

  if (view === name) {
    const target = bodies.get("detail");

    return target === undefined ? null : createPortal(detail, target);
  }

  const target = view === undefined ? bodies.get(`summary:${name}`) : undefined;

  return target === undefined ? null : createPortal(children, target);
}

function useHost(): Host {
  const host = useContext(HostContext);

  if (host === undefined) {
    throw new Error("The panel's parts need a SessionPanel");
  }

  return host;
}
