import { Button, Icon, Page, Segmented } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useQuery } from "../../data/hooks";
import { PluginCard } from "./plugin-card";
import { waitsForRestart, Restart } from "./restart";
import { Install } from "./install";

export function PluginsPage(): ReactElement {
  const plugins = useQuery("plugins.list").data ?? [];
  const [installing, setInstalling] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<"all" | "updates">("all");

  const updates = plugins.filter(
    ({ updateAvailable }) => updateAvailable === true,
  );

  const words = query.trim().toLowerCase();

  const listed = (shown === "all" ? plugins : updates).filter(
    ({ title, description }) =>
      `${title} ${description}`.toLowerCase().includes(words),
  );

  return (
    <Page
      id="plugins-page"
      title="Plugins"
      description="Features for everyone on this server. A plugin with settings adds its own page to this menu."
      actions={
        !installing && (
          <Button
            onClick={() => {
              setInstalling(true);
            }}
          >
            Install from git
          </Button>
        )
      }
    >
      {plugins.some(waitsForRestart) && <Restart />}
      {installing && (
        <Install
          onClose={() => {
            setInstalling(false);
          }}
        />
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <label className="flex h-9.5 min-w-60 flex-1 items-center gap-2 rounded-md border border-line bg-elevated px-3 focus-within:border-line-strong">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            aria-label="Search plugins"
            placeholder="Search plugins"
            className="flex-1 bg-transparent text-ui outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <Segmented
          label="Show"
          value={shown}
          onChange={setShown}
          options={[
            { value: "all", label: `Installed · ${String(plugins.length)}` },
            { value: "updates", label: `Updates · ${String(updates.length)}` },
          ]}
        />
      </div>
      <ul aria-label="Plugins" className="mt-6 grid gap-3 md:grid-cols-2">
        {listed.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} plugins={plugins} />
        ))}
      </ul>
      {listed.length === 0 && (
        <p className="mt-2 text-label text-fg-dim">
          {shown === "updates" && words === ""
            ? "Every plugin installed from git is up to date."
            : "No plugin matches."}
        </p>
      )}
      <p className="mt-6 text-caption text-fg-dim">
        Turning a plugin on or off applies when the server restarts, to open
        pages after a reload, and to Sessions the next time they start.
      </p>
    </Page>
  );
}
