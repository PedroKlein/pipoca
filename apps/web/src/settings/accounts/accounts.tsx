import { Page, PageTitle, Row, Rows } from "@pipoca/ui";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins } from "../../plugins";

// Everything Pi signs in to for the person, gathered from the plugins that
// keep it (ADR 0063).
export function AccountsPage(): ReactElement {
  const keepers = enabledPlugins().flatMap(({ name, settingsParts }) => {
    const Part = settingsParts?.Accounts;

    return Part === undefined ? [] : [{ name, Part }];
  });

  return (
    <Page id="accounts-page">
      <PageTitle description="Everything Pi signs in to on your behalf. Your Sessions use these accounts on every runner.">
        Accounts
      </PageTitle>
      {keepers.length === 0 && (
        <Rows label="Accounts">
          <Row
            title="No plugin keeps accounts on this server"
            description="Pi signs in with each runner's own logins. An admin can turn on a plugin that keeps model and git logins under Plugins."
          />
        </Rows>
      )}
      {keepers.map(({ name, Part }) => (
        <PluginBoundary key={name} name={name}>
          <Part />
        </PluginBoundary>
      ))}
    </Page>
  );
}
