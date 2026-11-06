import { writeSync } from "node:fs";

// Runs beside the test process's main thread, so it still runs while that
// thread's event loop is stuck in a loop that never yields, which bun's own
// test timeouts can't interrupt.
declare const self: Worker;

self.onmessage = ({
  data: { beat, limitMs },
}: MessageEvent<{ beat: Int32Array<SharedArrayBuffer>; limitMs: number }>) => {
  setInterval(() => {
    const quietMs = Date.now() / 1000 - Atomics.load(beat, 0);

    if (quietMs * 1000 > limitMs) {
      writeSync(
        2,
        `\nThe test process's event loop has been stuck for ${String(limitMs / 1000)} s, so the run stops here. The test that last started is the one stuck, or an earlier test left work running that never yields.\n`,
      );

      process.kill(process.pid, "SIGKILL");
    }
  }, 1000);
};
