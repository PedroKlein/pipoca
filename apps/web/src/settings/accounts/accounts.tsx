import { Page, Row, Rows } from "@pipoca/ui";
import type { ReactElement } from "react";
import { hasSettingsParts, SettingsSlot } from "../settings-slot";

// Everything Pi signs in to for the person, gathered from the plugins that
// keep it (ADR 0063).
export function AccountsPage(): ReactElement {
  return (
    <Page
      id="accounts-page"
      title="Accounts"
      description="Everything Pi signs in to on your behalf. Your Sessions use these accounts on every runner."
    >
      {!hasSettingsParts("Accounts") && (
        <Rows label="Accounts">
          <Row
            title="No plugin keeps accounts on this server"
            description="Pi signs in with each runner's own logins. An admin can turn on a plugin that keeps model and git logins under Plugins."
          />
        </Rows>
      )}
      <SettingsSlot slot="Accounts" />
    </Page>
  );
}
