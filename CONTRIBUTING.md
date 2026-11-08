# Contributing to Pipoca

Thanks for wanting to help. Pipoca is young and built by one person, so a short issue that says what you want to change, before a big pull request, saves both of us time. Bug reports with the exact command you ran and what you saw are always welcome.

## Build it from source

You need [Bun](https://bun.sh) and at least one model you can log in to from Pi.

```sh
git clone https://github.com/PedroKlein/pipoca && cd pipoca
bun install
bun run build
./apps/pipoca/dist/pipoca up --folder ~/code
```

`bun run build` compiles the `pipoca` binary into `apps/pipoca/dist/`. To build it for another machine, such as a Linux VM, pass the target: `bun run --cwd apps/pipoca build --target=bun-linux-x64 --outfile ../../dist/pipoca-linux` (`bun-linux-arm64` for ARM). The build also compiles the worker that runs Pi's `codemode` scripts, which a plain `bun build --compile` leaves out.

The desktop app also needs Rust: `bun run --cwd apps/desktop build` makes `Pipoca.app` and a disk image on macOS, or a `.deb` and AppImage on Linux (with WebKitGTK 4.1's development files installed), under `apps/desktop/src-tauri/target/release/bundle`. `bun run --cwd apps/desktop dev` runs it from source.

## Run it while you work

`bun run dev` runs the server with a built-in runner named `cloud`, and restarts it when a file under `apps/` or `packages/` changes. Its data lives in `~/.pipoca/dev`. With `PIPOCA_KEY` set to an Environment's key from Settings > Environments, it also runs an agent named `local` that may use this repository's folder.

The docs site lives in `apps/site` and reads the Markdown in `docs/`. `bun run --cwd apps/site dev` serves it with live reload.

## Check your change

```sh
bun run format
bun run lint
bun run typecheck
bun test
bun run test:e2e
```

Tests use Pi's faux model provider, so they need no API key. `bun run test:e2e` drives the web UI in headless Chromium; it needs Playwright's browser once (`bun x playwright-core install chromium`). `bun run smoke` checks Pipoca against your own Pi setup with one short prompt; pass `--model provider/id` to pick a cheap model. CI runs all of these, and builds the docs site, on every pull request.

## How the code is written

[AGENTS.md](AGENTS.md) has the conventions: package-by-domain, strict lint with no blanket suppressions, behavior tests through public interfaces, and almost no comments. [docs/design-system.md](docs/design-system.md) has the UI rules, and [docs/adr/](docs/adr/) the decisions behind the design. A change that alters a decision comes with a new decision record.

A bug fix comes with a test that fails before the fix and passes after it. A change to what Pipoca does comes with the matching change to the docs in `docs/`, which the site, GitHub and every Session's Pi read.

## Pull requests

- Keep one concern per pull request.
- Title it as a [Conventional Commit](https://www.conventionalcommits.org), such as `fix(changes): keep line comments after a reload`. Pull requests are squash-merged with that title.
- Say what changed and why, and how you checked it.

## Reporting a security issue

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
