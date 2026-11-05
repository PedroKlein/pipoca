import { apiPath, type ManifestEntry, type Profile } from "@pipoca/protocol";
import {
  Button,
  Card,
  Checkbox,
  ErrorText,
  Field,
  FileButton,
  Section,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../../api";
import { messageOf, upload } from "./upload";

export function Import({
  onChange,
}: {
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const [listed, setListed] = useState<{
    readonly url: string;
    readonly profiles: readonly ManifestEntry[];
  }>();

  const imported = (action: () => Promise<Profile | undefined>): void => {
    action().then(
      (profile) => {
        setError(undefined);

        if (profile) {
          onChange();
          location.hash = `profiles/${profile.id}`;
        }
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  const fromFile = async (file: File): Promise<Profile> => {
    if (file.name.endsWith(".json")) {
      return api("profiles.create", { body: JSON.parse(await file.text()) });
    }

    const name = file.name.replace(/\.(tar\.gz|tgz)$/, "");

    return api("profiles.archives.create", {
      query: { name },
      headers: { "content-type": "application/gzip" },
      body: file,
    });
  };

  const fromFolder = async (picked: readonly File[]): Promise<Profile> => {
    const name = picked[0]?.webkitRelativePath.split("/")[0] ?? "Imported";
    const profile = await api("profiles.create", { body: { name } });

    await upload(
      apiPath("profiles.files", { params: { id: profile.id } }),
      picked,
      {
        picked: true,
      },
    );

    return profile;
  };

  return (
    <Section title="Import a Profile">
      <Card padding="none" className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-label font-medium text-fg">
              From a folder
            </span>
            <span className="text-caption text-fg-dim">
              Such as your ~/.pi/agent. Logins and Session history stay behind.
            </span>
          </div>
          <FileButton
            multiple
            {...{ webkitdirectory: "" }}
            onFiles={(picked) => {
              imported(async () => fromFolder(picked));
            }}
          >
            Choose a folder
          </FileButton>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-label font-medium text-fg">
            From an exported .tar.gz
          </span>
          <FileButton
            accept=".gz,.tgz,.json,application/gzip,application/json"
            onFiles={([file]) => {
              if (file) {
                imported(async () => fromFile(file));
              }
            }}
          >
            Choose a file
          </FileButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = new FormData(event.currentTarget).get("url");

            const repository = typeof url === "string" ? url.trim() : "";

            imported(async () => {
              const { profiles } = await api("repositories.manifest", {
                query: { url: repository },
              });

              if (profiles.length > 0) {
                setListed({ url: repository, profiles });

                return undefined;
              }

              return api("profiles.create", {
                body: { source: { url: repository } },
              });
            });
          }}
          className="flex flex-col gap-1.5"
        >
          <Field label="From a git repository that holds a Profile folder">
            <span className="flex gap-2">
              <TextInput
                name="url"
                required
                placeholder="https://github.com/me/pi-setup.git"
                className="flex-1"
              />
              <Button type="submit">Import</Button>
            </span>
          </Field>
        </form>
        {listed && (
          <form
            aria-label="Profiles in the repository"
            onSubmit={(event) => {
              event.preventDefault();
              const paths = new FormData(event.currentTarget).getAll("path");

              imported(async () => {
                if (paths.length === 0) {
                  throw new Error("Pick at least one Profile.");
                }

                const profiles = await Promise.all(
                  paths
                    .flatMap((path) => (typeof path === "string" ? [path] : []))
                    .map(async (path) =>
                      api("profiles.create", {
                        body: { source: { url: listed.url, path } },
                      }),
                    ),
                );

                setListed(undefined);

                return profiles[0];
              });
            }}
            className="flex flex-col gap-2"
          >
            <span className="text-label text-fg-dim">
              Its pipoca.json lists these. Each one you bring follows the
              repository from then on.
            </span>
            {listed.profiles.map(({ name, path }) => (
              <Checkbox
                key={path}
                name="path"
                value={path}
                defaultChecked
                label={
                  <>
                    {name}{" "}
                    <span className="font-mono text-mono-sm text-fg-dim">
                      {path}
                    </span>
                  </>
                }
              />
            ))}
            <span>
              <Button variant="primary" type="submit">
                Bring them
              </Button>
            </span>
          </form>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </Card>
    </Section>
  );
}
