import { Segmented } from "@pipoca/ui";
import type { ReactElement } from "react";

export type View = "chat" | "pi" | "terminal";

export function ViewSwitch({
  view,
  onChange,
}: {
  readonly view: View;
  readonly onChange: (view: View) => void;
}): ReactElement {
  return (
    <Segmented
      label="View"
      compact
      value={view}
      onChange={onChange}
      options={[
        { value: "chat", label: "Chat", icon: "chat" },
        { value: "pi", label: "Pi", icon: "monitor" },
        { value: "terminal", label: "Terminal", icon: "terminal" },
      ]}
    />
  );
}

// While a browser shows Pi's TUI, extension dialogs open there (ADR 0027).
// What the Session asked to open in a browser, such as plannotator's review.
// A page on the Session's own machine opens through a preview (ADR 0037).
