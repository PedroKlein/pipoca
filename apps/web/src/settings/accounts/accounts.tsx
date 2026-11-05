import { Page, PageTitle } from "@pipoca/ui";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";

// Everything Pi signs in to for the person, gathered from the plugins that
// keep it (ADR 0063).
export function AccountsPage(): ReactElement {
  return (
    <Page id="accounts-page">
      <PageTitle description="Everything Pi signs in to on your behalf. Your Sessions use these accounts on every runner.">
        Accounts
      </PageTitle>
      {enabledPlugins().map(({ name, settingsParts }) => {
        const Part = settingsParts?.Accounts;

        return (
          Part && (
            <PluginBoundary key={name} name={name}>
              <Part context={pluginContext(name)} />
            </PluginBoundary>
          )
        );
      })}
    </Page>
  );
}
