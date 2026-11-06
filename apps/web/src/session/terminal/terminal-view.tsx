import { type TerminalTab, terminalTakenOver } from "@pipoca/protocol";
import { Button, Icon } from "@pipoca/ui";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { usePrimaryId } from "../../primary";
import { keyBar, type Modifier, modified } from "./keys";
import { openTerminal } from "./terminal";

export function TerminalView({
  sessionId,
  terminals,
}: {
  readonly sessionId: string;
  readonly terminals: readonly TerminalTab[];
}): ReactElement {
  const end = useRef<() => void>(() => undefined);

  const [active, setActive] = useState(
    () => terminals[0]?.id ?? crypto.randomUUID(),
  );

  const [closed, setClosed] = useState<string>();
  const [failures, setFailures] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [listed, setListed] = useState<string>();

  const shown = terminals.some(({ id }) => id === active);
  if (shown && listed !== active) {
    setListed(active);
  }

  // A listed terminal that drops out of the list has exited.
  const exited = listed === active && !shown;

  const reopen = useEffectEvent(() => {
    setClosed(undefined);
    if (exited) {
      setActive(terminals[0]?.id ?? crypto.randomUUID());
    } else {
      setGeneration(generation + 1);
    }
  });

  useEffect(() => {
    if (closed !== active) {
      return undefined;
    }

    const timer = setTimeout(
      () => {
        reopen();
      },
      exited ? 0 : Math.min(1000 * 2 ** failures, 30_000),
    );

    return () => {
      clearTimeout(timer);
    };
  }, [closed, active, exited, failures]);

  const tabs = shown
    ? terminals
    : [...terminals, { id: active, label: "New terminal" }];

  return (
    <>
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex items-center gap-1 overflow-x-auto border-b border-line bg-term-bg px-2 pt-1.5"
      >
        {tabs.map(({ id, label }) => (
          <span
            key={id}
            className="group/tab flex shrink-0 items-center rounded-t-md text-label text-fg-dim has-aria-selected:bg-panel has-aria-selected:text-fg-strong"
          >
            <button
              type="button"
              role="tab"
              aria-selected={id === active}
              onClick={() => {
                setActive(id);
              }}
              className="cursor-pointer py-1.5 pl-3 font-mono"
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => {
                if (id === active) {
                  end.current();
                }

                setActive(
                  terminals.find((other) => other.id !== id)?.id ??
                    crypto.randomUUID(),
                );
              }}
              className="invisible cursor-pointer px-2 py-1.5 group-has-aria-selected/tab:visible"
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </span>
        ))}
        <Button
          variant="ghost"
          iconOnly
          aria-label="New terminal"
          onClick={() => {
            setActive(crypto.randomUUID());
          }}
          className="h-7 w-7"
        >
          <Icon name="plus" className="size-4" />
        </Button>
      </div>
      <TerminalScreen
        key={generation}
        sessionId={sessionId}
        terminalId={active}
        endRef={end}
        onClosed={(reason, opened) => {
          if (reason !== terminalTakenOver) {
            setFailures(opened ? 0 : failures + 1);
            setClosed(active);
          }
        }}
      />
    </>
  );
}

export function TerminalScreen({
  sessionId,
  terminalId,
  endRef,
  onClosed,
}: {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly endRef?: RefObject<() => void>;
  // The shell or Pi's TUI ended, or the socket dropped.
  readonly onClosed?: (reason: string, opened: boolean) => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const elementId = usePrimaryId("terminal");
  const send = useRef<(data: string) => void>(() => undefined);
  const [modifier, setModifier] = useState<Modifier>();

  const typed = useEffectEvent((data: string): string => {
    setModifier(undefined);

    return modified(data, modifier);
  });

  const closed = useEffectEvent((reason: string, opened: boolean) => {
    onClosed?.(reason, opened);
  });

  useEffect(() => {
    if (!box.current) {
      return undefined;
    }

    const terminal = openTerminal(
      sessionId,
      terminalId,
      box.current,
      (data) => typed(data),
      (reason, opened) => {
        closed(reason, opened);
      },
    );

    send.current = terminal.send;

    if (endRef) {
      endRef.current = terminal.end;
    }

    return terminal.close;
  }, [sessionId, terminalId, endRef]);

  const keys: readonly {
    readonly label: string;
    readonly data?: string;
    readonly modifier?: Modifier;
  }[] = [
    ...keyBar.slice(0, 2),
    { label: "Ctrl", modifier: "ctrl" },
    { label: "Alt", modifier: "alt" },
    ...keyBar.slice(2),
  ];

  return (
    <>
      <div className="min-h-0 flex-1 bg-term-bg px-3 py-2">
        <div id={elementId} ref={box} className="h-full" />
      </div>
      <div
        role="toolbar"
        aria-label="Terminal keys"
        className="hidden gap-2 overflow-x-auto border-t border-line bg-panel px-2 py-2 max-md:flex pointer-coarse:flex"
      >
        {keys.map((key) => (
          <button
            key={key.label}
            type="button"
            aria-pressed={
              key.modifier === undefined ? undefined : modifier === key.modifier
            }
            // Keeps the focus, and with it the phone keyboard, on the terminal.
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              if (key.modifier === undefined) {
                send.current(modified(key.data ?? "", modifier));
                setModifier(undefined);
              } else {
                setModifier(
                  modifier === key.modifier ? undefined : key.modifier,
                );
              }
            }}
            className="h-10 min-w-12 shrink-0 cursor-pointer rounded-md border border-line bg-elevated px-3 font-mono text-label text-fg aria-pressed:border-accent aria-pressed:bg-accent-tint"
          >
            {key.label}
          </button>
        ))}
      </div>
    </>
  );
}
