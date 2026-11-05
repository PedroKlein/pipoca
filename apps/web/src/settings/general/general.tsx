import {
  Badge,
  Button,
  Card,
  Code,
  initialsOf,
  Page,
  PageTitle,
  Row,
  Rows,
  Section,
  Segmented,
  StatusMark,
} from "@pipoca/ui";
import type { ReactElement } from "react";
import { api } from "../../api";
import { useAccount } from "../../hooks";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";
import { useTheme } from "../../theme";
import { useVerbosity, type Verbosity, verbosities } from "../../verbosity";

const verbosityLabels = {
  quiet: "Quiet",
  normal: "Normal",
  verbose: "Verbose",
} as const;

export function GeneralPage({
  user,
  admin,
}: {
  readonly user: string;
  readonly admin: boolean;
}): ReactElement {
  const [theme, setTheme] = useTheme();
  const [verbosity, setVerbosity] = useVerbosity();
  const shown = useAccount()?.displayName ?? user;

  return (
    <Page id="general-page">
      <PageTitle description="You, and how Pipoca looks and behaves for you. Changes save as you make them.">
        General
      </PageTitle>
      <Rows label="You">
        <Row
          initials={initialsOf(shown)}
          round
          title={
            <>
              {shown}
              {admin && <Badge>Admin</Badge>}
            </>
          }
          description={`@${user} · signed in to ${location.host}`}
        />
      </Rows>
      <Section title="Appearance">
        <Rows>
          <Row title="Theme" description="Kept on this browser">
            <Segmented
              label="Theme"
              value={theme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "Match system" },
              ]}
              onChange={setTheme}
            />
          </Row>
          <Row
            title="Tool activity in chat"
            description="How much of an agent's work shows between messages. Every step stays one click away."
          >
            <Segmented
              label="Tool activity"
              value={verbosity}
              options={verbosities.map((value) => ({
                value,
                label: verbosityLabels[value],
              }))}
              onChange={setVerbosity}
            />
            <Preview verbosity={verbosity} />
          </Row>
        </Rows>
      </Section>
      {enabledPlugins().map(({ name, settingsParts }) => {
        const Part = settingsParts?.General;

        return (
          Part && (
            <PluginBoundary key={name} name={name}>
              <Part context={pluginContext(name)} />
            </PluginBoundary>
          )
        );
      })}
      <div className="mt-8 flex gap-2">
        <Button
          onClick={() => {
            void api("auth.session.remove").finally(() => {
              location.replace("/");
            });
          }}
        >
          Sign out
        </Button>
      </div>
    </Page>
  );
}

const previewSteps = [
  "Read plugins/routines/schedule.ts",
  "Ran bun test plugins/routines",
] as const;

// What a turn looks like at the chosen level, so the choice is clear
// before opening a Session.
function Preview({
  verbosity,
}: {
  readonly verbosity: Verbosity;
}): ReactElement {
  return (
    <Card
      padding="sm"
      aria-label="Preview"
      className="flex basis-full flex-col gap-2 bg-bg shadow-none"
    >
      <span className="text-caption text-fg-dim">Preview</span>
      {verbosity === "quiet" ? (
        <span className="flex items-center gap-2 text-label text-fg-dim">
          <StatusMark status="done" label="" />
          Ran the tests in plugins/routines
        </span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {previewSteps.map((step) => (
            <li
              key={step}
              className="flex items-center gap-2 text-label text-fg-dim"
            >
              <StatusMark status="done" label="" />
              {step}
            </li>
          ))}
        </ul>
      )}
      {verbosity === "verbose" && <Code>48 pass, 0 fail</Code>}
      <span className="text-ui text-fg">
        All 48 tests pass. I pushed the fix to the branch.
      </span>
    </Card>
  );
}
