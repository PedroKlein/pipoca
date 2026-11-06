import { tmpdir } from "node:os";
import { join } from "node:path";

// Session terminals start $SHELL, and a developer's interactive shell config
// (prompt plugins, slow startup, typeahead handling) shouldn't decide whether
// tests pass.
process.env["SHELL"] = "/bin/sh";

// Session processes load a real Pi, which would otherwise refresh its model
// catalog over the network.
process.env["PI_OFFLINE"] = "1";

// Sessions hosted in the test's own process can't set Pi's agent folder for
// its MCP extension, which then uses this one instead of the developer's own
// ~/.pi/agent.
process.env["PI_CODING_AGENT_DIR"] = join(tmpdir(), "pipoca-test-agent");

// A loop that never yields, such as one a test left running that a later
// test's instant fetch keeps answering, starves bun's test timeouts, so the
// run would hang with no output until CI kills it. A watchdog on its own
// thread stops it instead.
const beat = new Int32Array(new SharedArrayBuffer(4));

const heartbeat = (): void => {
  Atomics.store(beat, 0, Math.floor(Date.now() / 1000));
};

heartbeat();
setInterval(heartbeat, 1000).unref();

const watchdog = new Worker(new URL("test-watchdog.ts", import.meta.url));
watchdog.postMessage({ beat, limitMs: 60_000 });
watchdog.unref();
