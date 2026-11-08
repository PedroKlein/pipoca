import { uploadBlob, useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  ErrorText,
  FileButton,
  Row,
  Rows,
  Section,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { projects } from "../plugin";
import { bytes, type FolderFile, type FolderWrite } from "../src/model";

// A Project's folder, which every Session in it sees as project/ (ADR 0078).
// path is the Project's own, such as projects/<id>.
export function Folder({ path }: { readonly path: string }): ReactElement {
  const api = useApi(projects);

  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        api.get<{ files: FolderFile[]; perProjectBytes: number }>(
          `${path}/files`,
        ),
        api.get<{ writes: FolderWrite[] }>(`${path}/log`),
      ]),
    path,
    { changes: ["projects"] },
  );

  const files = value?.[0].files ?? [];
  const limit = value?.[0].perProjectBytes ?? Infinity;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const writes = value?.[1].writes ?? [];

  const [sending, setSending] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );

  const [error, setError] = useState<string>();

  const fileHref = (name: string): string =>
    `/api/ext/projects/${path}/file?path=${encodeURIComponent(name)}`;

  const upload = async (chosen: readonly File[]): Promise<void> => {
    setError(undefined);

    const results = await Promise.allSettled(
      chosen.map(async (file) => {
        const hash = await uploadBlob(api, file, (sent) => {
          setSending((now) =>
            new Map(now).set(file.name, sent / (file.size || 1)),
          );
        });

        await api.post(`${path}/files`, { path: file.name, hash });
      }),
    );

    setSending(new Map());
    reload();

    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ]
        : [],
    );

    if (failures.length > 0) {
      setError(failures.join("\n"));
    }
  };

  const remove = async (name: string): Promise<void> => {
    setError(undefined);

    try {
      await api.delete(`${path}/file?path=${encodeURIComponent(name)}`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }

    reload();
  };

  return (
    <>
      <Section
        title="Folder"
        description="Every Session in the Project sees these files in project/."
      >
        {total > limit && (
          <p className="text-label text-waiting">
            {`The folder holds ${bytes(total)}, more than the ${bytes(limit)} this server suggests for a Project. Nothing is deleted or refused.`}
          </p>
        )}
        {files.length === 0 ? (
          <p className="text-fg-dim">No files yet.</p>
        ) : (
          <Rows label="Folder">
            {files.map((file) => (
              <Row
                key={file.path}
                title={
                  <a
                    href={fileHref(file.path)}
                    download={file.path.split("/").at(-1)}
                    className="font-mono text-mono text-accent hover:underline"
                  >
                    {file.path}
                  </a>
                }
                description={`${bytes(file.size)} · ${file.actor} · ${new Date(file.updatedAt).toLocaleString()}`}
              >
                <Button
                  variant="ghost"
                  aria-label={`Remove ${file.path}`}
                  onClick={() => {
                    void remove(file.path);
                  }}
                >
                  Remove
                </Button>
              </Row>
            ))}
          </Rows>
        )}
        {[...sending].map(([name, part]) => (
          <p key={name} className="text-caption text-fg-dim">
            Uploading {name} {String(Math.floor(part * 100))}%
          </p>
        ))}
        <FileButton
          multiple
          aria-label="Upload files"
          className="self-start"
          onFiles={(picked) => {
            void upload(picked);
          }}
        >
          Upload files
        </FileButton>
        <ErrorText size="caption" className="whitespace-pre-line">
          {error}
        </ErrorText>
      </Section>
      <Section
        title="Recent writes"
        description="Earlier versions stay downloadable for a while."
      >
        {writes.length === 0 ? (
          <p className="text-fg-dim">Nothing written yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-label">
            {writes.map((write) => (
              <li key={write.id} className="flex flex-wrap items-center gap-2">
                <span className="text-fg-dim">
                  {new Date(write.at).toLocaleString()}
                </span>
                <span>
                  {write.actor} {write.hash === null ? "removed" : "wrote"}{" "}
                  {write.hash === null ? (
                    write.path
                  ) : (
                    <a
                      href={`/api/ext/projects/${path}/log/${write.id}`}
                      download={write.path.split("/").at(-1)}
                      className="font-mono text-accent hover:underline"
                    >
                      {write.path}
                    </a>
                  )}
                  {write.hash !== null && ` (${bytes(write.size)})`}
                </span>
                {write.conflict && <Badge state="waiting">conflict copy</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
