import { useLoaded, useApi } from "@pipoca/plugins/web";
import { FileButton, Section } from "@pipoca/ui";
import type { ReactElement } from "react";
import { projects } from "../plugin";
import type { LibraryFile, LibraryWrite } from "../src/model";

// A Project's files, which every Session in it reads and writes (ADR 0018).
// path is the Project's own, such as projects/<id>.
export function Library({ path }: { readonly path: string }): ReactElement {
  const api = useApi(projects);

  const base = path;

  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        api.get<LibraryFile[]>(`${base}/files`),
        api.get<LibraryWrite[]>(`${base}/log`),
      ]),
    base,
    { changes: ["projects"] },
  );

  const [files, writes] = value ?? [[], []];

  const filePath = (name: string): string =>
    `${base}/files/${encodeURIComponent(name)}`;

  const upload = async (chosen: readonly File[]): Promise<void> => {
    const results = await Promise.allSettled(
      chosen.map(async (file) =>
        api
          .raw(filePath(file.name), { method: "PUT", body: file })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`${file.name} didn't upload`);
            }
          }),
      ),
    );

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
      alert(failures.join("\n"));
    }
  };

  return (
    <>
      <Section title="Files">
        {files.length === 0 ? (
          <p className="text-fg-dim">No files yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {files.map((file) => (
              <li
                key={file.name}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5"
              >
                <a
                  href={filePath(file.name)}
                  download={file.name}
                  className="font-mono text-mono text-accent hover:underline"
                >
                  {file.name}
                </a>
                <span className="text-caption text-fg-dim">
                  {file.size} bytes · {file.actor} ·{" "}
                  {new Date(file.updatedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
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
      </Section>
      <Section title="Recent writes">
        {writes.length === 0 ? (
          <p className="text-fg-dim">Nothing written yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-label">
            {writes.map((write, index) => (
              <li key={`${String(index)}-${write.at}`}>
                <span className="text-fg-dim">
                  {new Date(write.at).toLocaleString()}
                </span>{" "}
                {write.actor} wrote {write.name} ({write.size} bytes)
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
