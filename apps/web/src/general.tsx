import {
  Badge,
  Button,
  Page,
  PageTitle,
  Row,
  Rows,
  Section,
  Segmented,
} from "@pipoca/ui";
import type { ReactElement } from "react";
import { api } from "./api";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";
import { useTheme } from "./theme";
import { useVerbosity, verbosities } from "./verbosity";

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

  return (
    <Page id="general-page">
      <PageTitle description="You, and how Pipoca looks and behaves for you. Changes save as you make them.">
        General
      </PageTitle>
      <Rows label="You">
        <Row
          initials={user.slice(0, 1).toUpperCase()}
          round
          title={
            <>
              {user}
              {admin && <Badge>Admin</Badge>}
            </>
          }
          description={`Signed in to ${location.host}`}
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
