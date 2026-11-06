import { json, ok } from "../../responses";
import { useLoaded } from "@pipoca/plugins/web";
import {
  Button,
  Card,
  ErrorText,
  Field,
  FileButton,
  Section,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { messageOf, upload } from "./upload";

interface ProfileFile {
  readonly path: string;
  readonly size: number;
}

// One kind of thing Pi loads from an agent folder, such as skills, found by
// where its files sit.
export interface Kind {
  readonly title: string;
  readonly about: string;
  // The name to list a file under, or undefined for files of other kinds
  // and a skill's own supporting files.
  readonly nameOf: (path: string) => string | undefined;
  readonly newPath: (name: string) => string;
  readonly template: (name: string) => string;
  readonly placeholder: string;
  // Uploads land in this folder, and a picked folder keeps its own name.
  // Without one, uploads land at the top and a picked folder, such as
  // ~/.pi/agent, leaves its name out.
  readonly folder?: string;
}

function sizeText(bytes: number): string {
  return bytes < 1024
    ? `${String(bytes)} B`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

export function useRun(
  reload: () => void,
): readonly [string | undefined, (action: () => Promise<void>) => void] {
  const [error, setError] = useState<string>();

  const run = (action: () => Promise<void>): void => {
    action().then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return [error, run];
}

// The files of one kind in a Profile's folder, each opened in a text editor.
export function KindFiles({
  url,
  kind,
}: {
  readonly url: string;
  readonly kind: Kind;
}): ReactElement {
  const { value: files = [], reload } = useLoaded(
    async () => json<ProfileFile[]>(fetch(url)),
    url,
    { topics: ["profiles"] },
  );

  const [open, setOpen] = useState<{ path: string; text: string }>();
  const [error, run] = useRun(reload);

  const fileUrl = (path: string): string =>
    `${url}/${encodeURIComponent(path)}`;

  const listed = files.flatMap((file) => {
    const name = kind.nameOf(file.path);

    return name === undefined ? [] : [{ ...file, name }];
  });

  const picker = (pickedFolder: boolean): ReactElement => (
    <FileButton
      multiple
      {...(pickedFolder && { webkitdirectory: "" })}
      onFiles={(picked) => {
        run(async () => {
          await upload(url, picked, {
            ...(kind.folder !== undefined && { folder: kind.folder }),
            picked: pickedFolder,
          });
        });
      }}
    >
      {pickedFolder ? "Upload a folder" : "Upload files"}
    </FileButton>
  );

  return (
    <Section title={kind.title}>
      <Card padding="none" className="flex flex-col gap-4 p-5">
        <p className="text-caption text-fg-dim">{kind.about}</p>
        <ul className="flex flex-col divide-y divide-line">
          {listed.map(({ path, size, name }) => (
            <li key={path} className="flex items-center gap-3 py-1.5">
              <button
                type="button"
                onClick={() => {
                  run(async () => {
                    const text = await (await ok(fetch(fileUrl(path)))).text();
                    setOpen({ path, text });
                  });
                }}
                className="flex min-w-0 flex-1 items-baseline gap-3 text-left text-fg hover:text-accent"
              >
                <span className="truncate font-mono text-mono-sm">{name}</span>
                {name !== path && (
                  <span className="truncate font-mono text-caption text-fg-dim">
                    {path}
                  </span>
                )}
              </button>
              <span className="text-caption text-fg-dim">{sizeText(size)}</span>
            </li>
          ))}
          {listed.length === 0 && (
            <li className="py-1.5 text-caption text-fg-dim">None yet.</li>
          )}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            if (typeof name === "string" && name.trim() !== "") {
              setOpen({
                path: kind.newPath(name.trim()),
                text: kind.template(name.trim()),
              });

              event.currentTarget.reset();
            }
          }}
          className="flex flex-wrap gap-2"
        >
          <TextInput
            name="name"
            aria-label={`New in ${kind.title}`}
            placeholder={kind.placeholder}
            className="min-w-48 flex-1 font-mono"
          />
          <Button type="submit">New</Button>
          {picker(false)}
          {picker(true)}
        </form>
        {open && (
          <FileEditor
            key={open.path}
            file={open}
            onSave={(text) => {
              run(async () => {
                await ok(
                  fetch(fileUrl(open.path), { method: "PUT", body: text }),
                );
              });
            }}
            onDelete={() => {
              run(async () => {
                await ok(fetch(fileUrl(open.path), { method: "DELETE" }));
                setOpen(undefined);
              });
            }}
            onClose={() => {
              setOpen(undefined);
            }}
          />
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </Card>
    </Section>
  );
}

function FileEditor({
  file,
  onSave,
  onDelete,
  onClose,
}: {
  readonly file: { readonly path: string; readonly text: string };
  readonly onSave: (text: string) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [text, setText] = useState(file.text);
  const [ask, asking] = useConfirm();

  return (
    <div className="flex flex-col gap-2">
      <Field label={file.path}>
        <TextArea
          value={text}
          rows={12}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="min-h-48 resize-y font-mono text-mono-sm"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            onSave(text);
          }}
        >
          Save file
        </Button>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="danger"
          onClick={() => {
            void ask({
              title: `Delete ${file.path}?`,
              confirm: "Delete file",
              danger: true,
            }).then((yes) => {
              if (yes) {
                onDelete();
              }
            });
          }}
        >
          Delete file
        </Button>
      </div>
      {asking}
    </div>
  );
}
