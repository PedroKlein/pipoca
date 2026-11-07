import type { PiPackage } from "@pipoca/protocol";
import {
  Badge,
  Button,
  Icon,
  Row,
  Rows,
  Section,
  Switch,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";

export function Packages({
  packages,
  editable,
  onSave,
}: {
  readonly packages: readonly PiPackage[];
  readonly editable: boolean;
  readonly onSave: (packages: readonly PiPackage[]) => void;
}): ReactElement {
  const [adding, setAdding] = useState(false);
  const latest = useLatest(packages);

  const replace = (index: number, pkg: PiPackage): void => {
    onSave(packages.map((each, n) => (n === index ? pkg : each)));
  };

  return (
    <Section
      title="Packages"
      description="Pi extensions, from npm, git or a folder"
      actions={
        editable && (
          <Button
            onClick={() => {
              setAdding(!adding);
            }}
          >
            <Icon name="plus" />
            Add package
          </Button>
        )
      }
    >
      {adding && (
        <form
          aria-label="Add package"
          onSubmit={(event) => {
            event.preventDefault();
            const source = new FormData(event.currentTarget).get("source");

            if (typeof source === "string" && source.trim() !== "") {
              onSave([...packages, source.trim()]);
              setAdding(false);
            }
          }}
          className="flex gap-2"
        >
          <TextInput
            name="source"
            required
            aria-label="Package source"
            placeholder="npm:pi-subagents, git:… or a path"
            className="flex-1 font-mono"
          />
          <Button type="submit">Add</Button>
        </form>
      )}
      {packages.length > 0 && (
        <Rows label="Packages">
          {packages.map((pkg, index) => {
            const source = typeof pkg === "string" ? pkg : pkg.source;
            const pinned = pinnedOf(source);
            const newer = pinned && latest.get(pinned.name);

            const update =
              newer !== undefined &&
              pinned !== undefined &&
              isNewer(newer, pinned.version);

            return (
              <Row
                key={`${source}:${String(index)}`}
                initials={source.slice(0, 2)}
                title={
                  <>
                    {nameOf(source)}
                    {update && <Badge state="working">{newer} available</Badge>}
                  </>
                }
                description={<span className="font-mono">{source}</span>}
              >
                {editable && update && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      replace(
                        index,
                        withSource(pkg, `npm:${pinned.name}@${newer}`),
                      );
                    }}
                  >
                    Update
                  </Button>
                )}
                {editable && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${source}`}
                    onClick={() => {
                      onSave(packages.filter((_each, n) => n !== index));
                    }}
                  >
                    Remove
                  </Button>
                )}
                <Switch
                  label={source}
                  labelHidden
                  checked={!isOff(pkg)}
                  disabled={!editable}
                  onChange={(on) => {
                    replace(index, on ? source : offPackage(source));
                  }}
                />
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

const resourceKinds = ["extensions", "skills", "prompts", "themes"] as const;

// Pi installs a package whose filters are all empty but loads none of it.
function offPackage(source: string): PiPackage {
  return {
    source,
    ...Object.fromEntries(resourceKinds.map((kind) => [kind, []])),
  };
}

function isOff(pkg: PiPackage): boolean {
  return (
    typeof pkg !== "string" &&
    resourceKinds.every((kind) => pkg[kind]?.length === 0)
  );
}

function isNewer(version: string, than: string): boolean {
  const parts = (text: string): readonly number[] =>
    text.split(".").map(Number);

  const [a, b] = [parts(version), parts(than)];
  const index = a.findIndex((part, n) => part !== b[n]);

  return index !== -1 && (a[index] ?? 0) > (b[index] ?? 0);
}

function withSource(pkg: PiPackage, source: string): PiPackage {
  return typeof pkg === "string" ? source : { ...pkg, source };
}

function pinnedOf(
  source: string,
): { readonly name: string; readonly version: string } | undefined {
  const match = /^npm:(@[^/@]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+)$/.exec(source);

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { name: match[1], version: match[2] };
}

// The latest version on npm of each package pinned to one.
function useLatest(
  packages: readonly PiPackage[],
): ReadonlyMap<string, string> {
  const names = [
    ...new Set(
      packages.flatMap((pkg) => {
        const pinned = pinnedOf(typeof pkg === "string" ? pkg : pkg.source);

        return pinned ? [pinned.name] : [];
      }),
    ),
  ].join(" ");

  const [latest, setLatest] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (names === "") {
      return;
    }

    void Promise.all(
      names.split(" ").map(async (name) => {
        const response = await fetch(
          `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
        );

        const { version } = (await response.json()) as { version?: unknown };

        return typeof version === "string" ? [[name, version] as const] : [];
      }),
    )
      .then((found) => {
        setLatest(new Map(found.flat()));
      })
      .catch(() => undefined);
  }, [names]);

  return latest;
}

export function nameOf(source: string): string {
  const name = source
    .replace(/^(npm|git):/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .at(-1)
    ?.replace(/(.)@[^@]*$/, "$1");

  return name === undefined || name === "" ? source : name;
}
