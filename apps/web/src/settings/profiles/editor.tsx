import { apiPath, type Profile } from "@pipoca/protocol";
import {
  Button,
  cardClass,
  Checkbox,
  cn,
  Field,
  ListInput,
  Section,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { request } from "../../data/client";
import { useMe } from "../../data/hooks";
import { navigate, scopedHref } from "../../router";
import { useRun } from "./files";
import { packageText, packageOf } from "./layers";
import { BuildsOn } from "./builds-on";

export function Editor({
  profile,
  profiles,
  team = false,
  saved = false,
  onSaved,
}: {
  readonly profile?: Profile;
  readonly profiles: readonly Profile[];
  readonly team?: boolean;
  readonly saved?: boolean;
  readonly onSaved?: () => void;
}): ReactElement {
  const [ask, asking] = useConfirm();
  const { admin } = useMe();

  const [packages, setPackages] = useState<readonly string[]>(() =>
    (profile?.packages ?? []).map(packageText),
  );

  const [buildsOn, setBuildsOn] = useState(profile?.buildsOn ?? null);
  const [error, run] = useRun();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    run(async () => {
      const body = {
        name: text("name"),
        description: text("description"),
        packages: packages.map(packageOf),
        buildsOn,
      };

      if (profile) {
        // Only what changed here, so a file edited below or by hand since
        // isn't written back as it was.
        const changed = Object.fromEntries(
          Object.entries(body).filter(
            ([key, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(profile[key as keyof typeof body]),
          ),
        );

        await request("profiles.update", {
          params: { id: profile.id },
          body: changed,
        });

        onSaved?.();

        return;
      }

      const created = await request("profiles.create", {
        body: {
          ...body,
          ...(team ? { team: true } : { shared: form.get("shared") === "on" }),
        },
      });

      navigate(scopedHref(team, "profiles", created.id));
    });
  };

  return (
    <Section
      title={profile ? "This Profile" : `New ${team ? "team " : ""}Profile`}
    >
      <form
        onSubmit={submit}
        className={cn(cardClass, "flex flex-col gap-4 p-5")}
      >
        <Field label="Name">
          <TextInput name="name" required defaultValue={profile?.name ?? ""} />
        </Field>
        <Field
          label="What it's for"
          hint="Your assistant reads this to pick a Profile for new work."
        >
          <TextInput
            name="description"
            maxLength={300}
            placeholder="Our services, with kubectl and the cluster skills"
            defaultValue={profile?.description ?? ""}
          />
        </Field>
        {!profile && !team && (
          <Checkbox
            name="shared"
            label="Shared with everyone. Only admins can change it."
          />
        )}
        {!profile && (
          <BuildsOn
            profile={profile}
            profiles={profiles}
            value={buildsOn}
            team={team}
            onChange={setBuildsOn}
          />
        )}
        {!profile && (
          <ListInput
            label="Pi packages"
            values={packages}
            placeholder="npm:pi-subagents, git:… or a path, then Enter"
            onChange={setPackages}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!profile?.source && (
            <Button variant="primary" type="submit">
              {profile ? "Save" : "Create Profile"}
            </Button>
          )}
          {profile &&
            !profile.isDefault &&
            (profile.ownerId !== "team" || admin) && (
              <Button
                onClick={() => {
                  run(async () => {
                    await request("profiles.update", {
                      params: { id: profile.id },
                      body: { isDefault: true },
                    });
                  });
                }}
              >
                {profile.ownerId === "team"
                  ? "Make team default"
                  : "Make default"}
              </Button>
            )}
          {profile &&
            admin &&
            profile.id !== "default" &&
            profile.ownerId !== "team" &&
            !profile.source && (
              <Button
                onClick={() => {
                  run(async () => {
                    await request("profiles.update", {
                      params: { id: profile.id },
                      body: { shared: profile.ownerId !== null },
                    });
                  });
                }}
              >
                {profile.ownerId === null
                  ? "Make it mine only"
                  : "Share with everyone"}
              </Button>
            )}
          {profile && (
            <a
              href={apiPath("profiles.archive", {
                params: { id: profile.id },
              })}
              download
              className="inline-flex h-control items-center rounded-md px-3 text-ui font-medium text-fg-dim hover:bg-hover hover:text-fg"
            >
              Export
            </a>
          )}
          {profile && !profile.isDefault && (
            <Button
              variant="danger"
              onClick={() => {
                void ask({
                  title: `Delete the Profile "${profile.name}"?`,
                  confirm: "Delete",
                  danger: true,
                }).then((yes) => {
                  if (!yes) {
                    return;
                  }

                  run(async () => {
                    await request("profiles.remove", {
                      params: { id: profile.id },
                    });

                    navigate(
                      scopedHref(profile.ownerId === "team", "profiles"),
                    );
                  });
                });
              }}
            >
              Delete
            </Button>
          )}
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
      {asking}
    </Section>
  );
}
