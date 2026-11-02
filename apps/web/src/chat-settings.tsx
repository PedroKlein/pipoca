import { Field, PageTitle, Select } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useVerbosity, type Verbosity, verbosities } from "./verbosity";

const levels: Readonly<Record<Verbosity, string>> = {
  quiet: "Quiet: one line for what the agent is doing now",
  normal: "Normal: every step while it works, folded after",
  verbose: "Verbose: every step and its output, always open",
};

export function ChatSettingsPage(): ReactElement {
  const [verbosity, setVerbosity] = useVerbosity();

  return (
    <div
      id="chat-settings-page"
      className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
    >
      <PageTitle description="How much of an agent's work the chat shows. A turn's steps stay one click away at every level. The choice is kept on this browser.">
        Chat
      </PageTitle>
      <Field label="Tool activity">
        <Select
          value={verbosity}
          onChange={(event) => {
            const chosen = verbosities.find(
              (each) => each === event.target.value,
            );

            if (chosen !== undefined) {
              setVerbosity(chosen);
            }
          }}
        >
          {verbosities.map((each) => (
            <option key={each} value={each}>
              {levels[each]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
