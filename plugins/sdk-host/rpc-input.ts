/** How the claimed RPC source was given back; a cleanup failure is retained, never thrown or dropped. */
export type RpcInputRelease = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** Stock RPC input plus its release outcome, the one cleanup seam a host joins. */
export interface CancellableRpcInput {
  readonly input: ReadableStream<Uint8Array>;
  readonly released: Promise<RpcInputRelease>;
}

/**
 * Makes stock RPC input from `source`, the stream public `claimRpcInput()` returned, error (never end)
 * with exactly `signal.reason` when `signal` aborts. Stock RPC mode reads its input without a signal,
 * so the error rejects `runRpcMode` at its input await instead of waiting for an EOF a cancelled host
 * never receives.
 *
 * Abort errors `input` at once, whether or not anyone reads it, then cancels `source` (whose own cancel
 * releases Bun's stdin reader) and unlocks it; nothing waits on unconsumed input. Each pull forwards
 * exactly one read of `source`; its EOF and read errors pass through unchanged.
 *
 * `released` is the single cleanup owner's outcome: it always resolves, once `source` is unlocked
 * after EOF, a read error, abort or a consumer cancel, and retains any cancel or unlock failure.
 *
 * This is a hard cancel: RPC commands already accepted are not drained and frames still queued for
 * stdout are not flushed. Only stdin EOF takes stock RPC mode's draining exit.
 */
export function cancellableRpcInput(source: ReadableStream<Uint8Array>, signal: AbortSignal): CancellableRpcInput {
  const reader = source.getReader();
  const outcome = Promise.withResolvers<RpcInputRelease>();
  let releasing: Promise<RpcInputRelease> | undefined;
  // Whichever terminal path arrives first owns the release; it runs once and never rejects.
  const release = (cancel: boolean, reason?: unknown) => releasing ??= (async (): Promise<RpcInputRelease> => {
    signal.removeEventListener("abort", abort);
    try {
      try {
        if (cancel) await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  })().then(record => {
    outcome.resolve(record);
    return record;
  });
  let input!: ReadableStreamDefaultController<Uint8Array>;
  function abort() {
    input.error(signal.reason);
    void release(true, signal.reason);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      input = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (releasing) return;
        controller.error(error);
        await release(false);
        return;
      }
      // Cancelling `source` settles a parked read as done: never report that as EOF.
      if (releasing) return;
      if (result.done) {
        controller.close();
        await release(false);
      } else {
        controller.enqueue(result.value);
      }
    },
    // A consumer cancel shares the one release; its failure reaches that consumer and stays in `released`.
    async cancel(reason) {
      const record = await release(true, reason);
      if (!record.ok) throw record.error;
    },
  }, { highWaterMark: 0 });
  return { input: stream, released: outcome.promise };
}
