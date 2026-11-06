// A promise that some library leaves to reject once the server listens.
const write = process.stderr.write.bind(process.stderr);

process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  if (String(chunk).includes("server listening")) {
    setImmediate(() => {
      void Promise.reject(new Error("stray rejection"));
    });
  }

  return write(chunk, ...rest);
});
