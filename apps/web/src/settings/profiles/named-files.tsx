import { ok } from "../../responses";
import { useLoaded } from "@pipoca/plugins/web";
import { Button, Card, ErrorText, Field, Section, TextArea } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useRun } from "./files";

export interface OneFile {
  readonly path: string;
  readonly about: string;
  readonly example: string;
}

// Files Pi reads by a fixed name, such as mcp.json. Saving one empty deletes
// it.
export function NamedFiles({
  url,
  title,
  files,
}: {
  readonly url: string;
  readonly title: string;
  readonly files: readonly OneFile[];
}): ReactElement {
  const { value: texts, reload } = useLoaded(
    async () =>
      Promise.all(
        files.map(async ({ path }) => {
          const response = await fetch(`${url}/${encodeURIComponent(path)}`);

          return response.ok ? response.text() : "";
        }),
      ),
    `${url}:${files.map(({ path }) => path).join()}`,
    { topics: ["profiles"] },
  );

  return (
    <Section title={title}>
      <Card padding="none" className="flex flex-col gap-6 p-5">
        {texts &&
          files.map((file, n) => (
            <NamedFile
              key={`${file.path}:${texts[n] ?? ""}`}
              url={`${url}/${encodeURIComponent(file.path)}`}
              file={file}
              text={texts[n] ?? ""}
              onSaved={reload}
            />
          ))}
      </Card>
    </Section>
  );
}

function NamedFile({
  url,
  file,
  text: saved,
  onSaved,
}: {
  readonly url: string;
  readonly file: OneFile;
  readonly text: string;
  readonly onSaved: () => void;
}): ReactElement {
  const [text, setText] = useState(saved);
  const [error, run] = useRun(onSaved);

  const save = async (): Promise<void> => {
    if (text.trim() === "") {
      if (saved !== "") {
        await ok(fetch(url, { method: "DELETE" }));
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

    await ok(fetch(url, { method: "PUT", body: text }));
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
