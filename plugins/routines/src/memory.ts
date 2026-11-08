import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export const memoryFilePattern = /^[a-z0-9][a-z0-9-]{0,62}\.md$/;

export const defaultMemoryFile = "decisions.md";

const maxFiles = 50;
const maxFileChars = 200_000;

// A group's memory (ADR 0075): Markdown files its runs read and add dated
// notes to. Notes are appended with one synchronous write each, so runs
// that write at once never overwrite each other.
export interface GroupMemory {
  readonly files: () => Readonly<Record<string, string>>;
  readonly note: (file: string, text: string, at: number, by: string) => void;
}

export function groupMemory(folder: string): GroupMemory {
  return {
    files: (): Readonly<Record<string, string>> => {
      if (!existsSync(folder)) {
        return {};
      }

      return Object.fromEntries(
        readdirSync(folder)
          .filter((file) => memoryFilePattern.test(file))
          .sort()
          .slice(0, maxFiles)
          .map((file) => [
            file,
            tail(readFileSync(join(folder, file), "utf8")),
          ]),
      );
    },
    note: (file: string, text: string, at: number, by: string): void => {
      if (!memoryFilePattern.test(file)) {
        throw new Error(
          `${file}: a memory file is lower-case letters, digits and dashes, ending in .md`,
        );
      }

      mkdirSync(folder, { recursive: true });

      appendFileSync(
        join(folder, file),
        `## ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC, ${by}\n\n${text.trim()}\n\n`,
      );
    },
  };
}

// The newest part of a long file, since its notes are added at the end.
function tail(text: string): string {
  return text.length > maxFileChars
    ? `…\n${text.slice(text.length - maxFileChars)}`
    : text;
}
