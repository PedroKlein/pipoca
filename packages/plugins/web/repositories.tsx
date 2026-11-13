import {
  checkoutName,
  type RepositoryChoice,
  repositoryHost,
} from "@pipoca/protocol";
import { RepoPicker, type RepoOption } from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { ago, useNow } from "./index";
import { useShell } from "./shell";

// Typing searches the git hosts once it pauses for this long.
const searchDelayMs = 250;

function repositoryOption(
  { url, name, host, pushedAt, language, private: hidden }: RepositoryChoice,
  now: number,
): RepoOption {
  const where = host ?? repositoryHost(url);

  return {
    value: url,
    name,
    host: where,
    meta: [
      pushedAt === undefined ? undefined : `pushed ${ago(pushedAt, now)}`,
      language,
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
    private: hidden,
  };
}

// A recent one says its host too, since it is listed above the hosts.
function placeOption(where: string, found?: RepoOption): RepoOption {
  if (found !== undefined) {
    return {
      ...found,
      meta: [found.host, found.meta].filter(Boolean).join(" · "),
    };
  }

  return {
    value: where,
    name: checkoutName(where) ?? where,
    host: repositoryHost(where),
    meta: where,
  };
}

// Picks repositories on the git hosts the person reaches, or for team work
// the ones the team's bots reach, and folders on the Environment.
export function RepositoryField({
  label,
  children,
  selected,
  recent,
  folders,
  team,
  placeholder = "Search, or paste a repository URL",
  footer,
  hint,
  onChange,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly selected: readonly string[];
  // Repositories and folders used last, newest first.
  readonly recent: readonly string[];
  readonly folders?:
    { readonly label: string; readonly paths: readonly string[] } | undefined;
  readonly team: boolean;
  readonly placeholder?: string;
  readonly footer?: ReactNode;
  readonly hint?: ReactNode;
  readonly onChange: (values: readonly string[]) => void;
}): ReactElement {
  const shell = useShell();
  const now = useNow();
  const [found, setFound] = useState<readonly RepositoryChoice[]>([]);
  const searches = useRef(0);

  // Only the latest search's answer is shown, whichever arrives first.
  const search = (query: string): void => {
    const ticket = ++searches.current;

    setTimeout(
      () => {
        if (ticket !== searches.current) {
          return;
        }

        void shell.repositories(query, team).then((repositories) => {
          if (ticket === searches.current) {
            setFound(repositories);
          }
        });
      },
      query === "" ? 0 : searchDelayMs,
    );
  };

  const opened = useEffectEvent(() => {
    search("");
  });

  useEffect(() => {
    opened();
  }, [team]);

  const repositories = found.map((choice) => repositoryOption(choice, now));
  const byValue = new Map(repositories.map((option) => [option.value, option]));

  return (
    <RepoPicker
      label={label}
      selected={selected}
      repositories={repositories}
      recent={recent.map((where) => placeOption(where, byValue.get(where)))}
      {...(folders && {
        folders: {
          label: folders.label,
          options: folders.paths.map((path) => placeOption(path)),
        },
      })}
      placeholder={placeholder}
      footer={footer}
      hint={hint}
      onSearch={search}
      onChange={onChange}
    >
      {children}
    </RepoPicker>
  );
}
