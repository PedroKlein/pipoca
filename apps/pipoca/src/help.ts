import { version } from "../package.json";

interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly about: string;
  readonly options: readonly (readonly [string, string])[];
  readonly examples?: readonly string[];
}

const commands: readonly Command[] = [
  {
    name: "up",
    summary: "run Pipoca for yourself on this machine and open it",
    usage: "pipoca up [options]",
    about: `Starts a server for you alone, with Sessions running on this machine in
the folders you share, and opens your browser signed in. When one is
already running, it only opens it. Log in to a model with /login in any
Session.`,
    options: [
      [
        "--folder <path>",
        "a folder Sessions can work in; repeat for more (default: the current folder)",
      ],
      ["--port <n>", "port to serve on (default: 7420)"],
      [
        "--database <path>",
        "where the server keeps its data (default: ~/.pipoca/server.db)",
      ],
      ["--print-link", "print the sign-in link instead of opening the browser"],
    ],
    examples: ["cd ~/code && pipoca up"],
  },
  {
    name: "connect",
    summary: "use Pipoca on another machine over SSH",
    usage: "pipoca connect <user@host> [options]",
    about: `Tunnels to the server on a machine you reach with SSH, such as a VM,
and opens your browser signed in through it. This machine joins it too,
so Sessions can also run here, in the folders you share. A machine with
no pipoca gets this version from GitHub, installed in ~/.pipoca/bin and
started as a service. The tunnel comes back whenever it drops.`,
    options: [
      [
        "--folder <path>",
        "a folder of this machine Sessions can work in; repeat for more (default: the current folder)",
      ],
      ["--port <n>", "the server's port on the other machine (default: 7420)"],
      ["--local-port <n>", "the tunnel's port here (default: 7420)"],
      ["--no-open", "don't open the browser"],
      ["--print-link", "print the sign-in link instead of opening the browser"],
      [
        "--remote-pipoca <path>",
        "pipoca on the other machine, when it isn't on its PATH",
      ],
      [
        "--remote-database <path>",
        "the database of the server there, when it runs with --database",
      ],
      ["--name <name>", "this machine's name there (default: its host name)"],
      [
        "--data-dir <path>",
        "where this machine keeps its Sessions (default: ~/.pipoca/servers/<host>)",
      ],
    ],
    examples: ["cd ~/code && pipoca connect me@my-vm"],
  },
  {
    name: "link",
    summary: "print a link that signs you in to the server running here",
    usage: "pipoca link [options]",
    about: `Asks the server pipoca up started on this machine for a one-time
sign-in link. Only your own system user can ask.`,
    options: [
      ["--open", "open the link in the browser"],
      [
        "--database <path>",
        "the database of that server (default: ~/.pipoca/server.db)",
      ],
    ],
  },
  {
    name: "service",
    summary: "start pipoca up or pipoca connect at every login",
    usage: `pipoca service install up [up's options]
pipoca service install connect <user@host> [connect's options]
pipoca service uninstall`,
    about: `Installs a launchd agent on macOS or a systemd user unit on Linux that
runs the command at login and starts it again when it stops. It opens no
browser; get a link with pipoca link. Folders default to the folder you
install it from.`,
    options: [],
    examples: ["cd ~/code && pipoca service install up"],
  },
  {
    name: "server",
    summary: "run a server for a team, or one you configure yourself",
    usage: "[PIPOCA_SECRET_KEY=<32 bytes, base64>] pipoca server [options]",
    about: `Starts a server with no runner of its own. Its log shows a one-time
setup link for its first user. Machines join it with pipoca agent, or
a plugin starts runners for it, such as Kubernetes pods. Set
PIPOCA_SECRET_KEY to keep logins encrypted with a key of your own.`,
    options: [
      ["--host <address>", "address to listen on (default: 127.0.0.1)"],
      ["--port <n>", "port to serve on (default: 7420)"],
      ["--url <url>", "the address people reach it at, behind a proxy"],
      [
        "--database <path>",
        "where it keeps its data (default: ~/.pipoca/server.db)",
      ],
      ["--sso-only", "sign in only with single sign-on, not passwords"],
      ["--trust-proxy", "read the client's address from X-Forwarded-For"],
      ["--supervise", "start it again when a plugin asks for a restart"],
      [
        "--solo",
        "serve only you, with a runner on this machine (what pipoca up runs)",
      ],
      [
        "--folder <path>",
        "with --solo or --provider, a folder Sessions can work in",
      ],
      [
        "--plugins <path>",
        "folder of installed plugins (default: plugins next to the database)",
      ],
      [
        "--config-dir <path>",
        "folder of config files (default: config next to the database)",
      ],
      [
        "--locked-config <path>",
        "a pipoca.json whose plugin keys Settings can't change, such as Helm's",
      ],
      [
        "--provider <name>",
        "also run Sessions on this machine, as a runner with this name",
      ],
      [
        "--data-dir <path>",
        "with --provider, where Sessions are kept (default: ~/.pipoca/server)",
      ],
      [
        "--extension <path>",
        "with --provider, a Pi extension every Session loads; repeat for more",
      ],
    ],
  },
  {
    name: "agent",
    summary: "run Sessions on this machine for a server",
    usage: "PIPOCA_KEY=<Environment key> pipoca agent [options]",
    about: `Joins a server as a runner of one of its Environments, with the key
the Environments page shows, and runs that Environment's Sessions here.`,
    options: [
      ["--server <url>", "the server to join (default: http://127.0.0.1:7420)"],
      [
        "--folder <path>",
        "a folder Sessions can work in; repeat for more (default: the current folder)",
      ],
      ["--name <name>", "this machine's name there (default: its host name)"],
      ["--capacity <n>", "how many Sessions run here at once"],
      [
        "--reach <host[:port]>",
        "a private host the server may reach through this machine; repeat for more",
      ],
      ["--exit-when-idle <seconds>", "stop after this long with no Session"],
      [
        "--data-dir <path>",
        "where Sessions are kept (default: ~/.pipoca/agent for this machine's own server, ~/.pipoca/servers/<host> for another)",
      ],
      [
        "--extension <path>",
        "a Pi extension every Session loads; repeat for more",
      ],
    ],
    examples: ["PIPOCA_KEY=pck_… pipoca agent --server https://pipoca.example"],
  },
];

const width = Math.max(...commands.map((command) => command.name.length));

export function overview(): string {
  return `Pipoca ${version}: run Pi coding-agent Sessions on your own machines and
pick them up from any browser.

usage: pipoca <command> [options]

commands:
${commands
  .map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`)
  .join("\n")}

Run pipoca <command> --help to see a command's options.
Start with pipoca up in the folder with your code.

Docs: https://pipoca.dev/docs/`;
}

// A name that isn't a command gets nothing, so the caller can say so.
export function help(name: string): string | undefined {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    return undefined;
  }

  const flag = Math.max(...command.options.map(([option]) => option.length));

  const sections = [
    `${command.summary}\n\nusage: ${command.usage.replaceAll("\n", "\n       ")}`,
    command.about,
  ];

  if (command.options.length > 0) {
    sections.push(
      `options:\n${command.options
        .map(([option, text]) =>
          wrap(text, 80 - flag - 4)
            .map((line, index) =>
              `  ${(index === 0 ? option : "").padEnd(flag)}  ${line}`.trimEnd(),
            )
            .join("\n"),
        )
        .join("\n")}`,
    );
  }

  if (command.examples !== undefined) {
    sections.push(
      `example:\n${command.examples.map((line) => `  ${line}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function wrap(text: string, columns: number): string[] {
  const lines = [""];

  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    const line = lines[last] ?? "";

    if (line !== "" && line.length + 1 + word.length > columns) {
      lines.push(word);
    } else {
      lines[last] = line === "" ? word : `${line} ${word}`;
    }
  }

  return lines;
}

export { version };
