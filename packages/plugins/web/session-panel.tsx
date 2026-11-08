import { Button, Icon, type IconName, Segmented, SidePanel } from "@pipoca/ui";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Tab {
  readonly name: string;
  readonly label: string;
  readonly order: number;
}

interface Panel {
  readonly active: string | undefined;
  readonly body: HTMLElement | null;
  readonly show: (name: string | undefined) => void;
  readonly add: (tab: Tab) => () => void;
}

const PanelContext = createContext<Panel | undefined>(undefined);

// One panel beside a Session whose tabs plugins fill, such as Artifacts,
// Files and Changes (ADR 0078). The app draws it around a Session's view.
export function SessionPanel({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [body, setBody] = useState<HTMLElement | null>(null);

  const add = useCallback((tab: Tab) => {
    setTabs((now) => [...now.filter(({ name }) => name !== tab.name), tab]);

    return () => {
      setTabs((now) => now.filter(({ name }) => name !== tab.name));
    };
  }, []);

  const shown = tabs.find(({ name }) => name === active);

  const panel = useMemo(
    () => ({ active: shown?.name, body, show: setActive, add }),
    [shown, body, add],
  );

  return (
    <PanelContext value={panel}>
      {children}
      {shown !== undefined && (
        <SidePanel
          open
          title={shown.label}
          closeLabel="Close panel"
          size="lg"
          className="gap-6"
          onClose={() => {
            setActive(undefined);
          }}
        >
          {tabs.length > 1 && (
            <Segmented
              label="Panel"
              value={shown.name}
              options={[...tabs]
                .sort((a, b) => a.order - b.order)
                .map(({ name, label }) => ({ value: name, label }))}
              onChange={setActive}
            />
          )}
          <div ref={setBody} className="flex flex-col gap-6" />
        </SidePanel>
      )}
    </PanelContext>
  );
}

// A plugin's tab in its Session's panel, with the button in the Session's
// header that opens it. Not drawing one hides both.
export function SessionTab({
  name,
  order,
  label,
  button,
  icon,
  children,
}: {
  readonly name: string;
  // Where the tab sits, lowest first: Artifacts 10, Files 20, Changes 30.
  readonly order: number;
  // The tab and the panel's title, such as "Files 7".
  readonly label: string;
  // The header button's accessible name.
  readonly button: string;
  readonly icon: IconName;
  readonly children: ReactNode;
}): ReactElement {
  const { active, body, show, add } = usePanel();
  const open = active === name;

  useEffect(() => add({ name, label, order }), [add, name, label, order]);

  return (
    <>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-label={button}
        onClick={() => {
          show(open ? undefined : name);
        }}
      >
        <Icon name={icon} className="size-3.5" />
        {label}
      </Button>
      {open && body !== null && createPortal(children, body)}
    </>
  );
}

function usePanel(): Panel {
  const panel = useContext(PanelContext);

  if (panel === undefined) {
    throw new Error("SessionTab needs a SessionPanel around the Session");
  }

  return panel;
}
