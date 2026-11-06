import { Button, Card, ErrorText, Field, Section, TextArea } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useLoad } from "../../data/hooks";
import type { Folder } from "./folder";
import { useRun } from "./files";

export interface OneFile {
  readonly path: string;
  readonly about: string;
  readonly example: string;
}

// Files Pi reads by a fixed name, such as mcp.json. Saving one empty deletes
// it.
export function NamedFiles({
  folder,
  title,
  files,
}: {
  readonly folder: Folder;
  readonly title: string;
  readonly files: readonly OneFile[];
}): ReactElement {
  const texts = useLoad(
    `${folder.key} ${files.map(({ path }) => path).join()}`,
    async () => Promise.all(files.map(async ({ path }) => folder.read(path))),
    { topics: ["profiles"] },
  ).data;

  return (
    <Section title={title}>
      <Card padding="none" className="flex flex-col gap-6 p-5">
        {texts &&
          files.map((file, n) => (
            <NamedFile
              key={`${file.path}:${texts[n] ?? ""}`}
              folder={folder}
              file={file}
              text={texts[n] ?? ""}
            />
          ))}
      </Card>
    </Section>
  );
}

function NamedFile({
  folder,
  file,
  text: saved,
}: {
  readonly folder: Folder;
  readonly file: OneFile;
  readonly text: string;
}): ReactElement {
  const [text, setText] = useState(saved);
  const [error, run] = useRun();

  const save = async (): Promise<void> => {
    if (text.trim() === "") {
      if (saved !== "") {
        await folder.remove(file.path);
      }

      return;
    }

    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch {
        throw new Error(`${file.path} isn't valid JSON.`);
      }
    }

    await folder.write(file.path, text);
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label={file.path}>
        <TextArea
          value={text}
          rows={8}
          placeholder={file.example}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="min-h-32 resize-y font-mono text-mono-sm"
        />
      </Field>
      <p className="text-caption text-fg-dim">{file.about}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={text === saved}
          onClick={() => {
            run(save);
          }}
        >
          Save
        </Button>
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    </div>
  );
}
