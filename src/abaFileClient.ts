import type {
  AbaFileRequest,
  AbaFileResult,
  WorkerRequest,
  WorkerResult,
} from "./abaFileProtocol.ts";
import { createAbaFileSession, readError } from "./abaFileSession.ts";

type PendingRequest = {
  resolve: (result: AbaFileResult) => void;
  reject: (cause: unknown) => void;
};

function startWorker() {
  const worker = new Worker(new URL("./aba.worker.ts", import.meta.url), {
    type: "module",
  });
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, PendingRequest>();

  function stop(cause: unknown) {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const { reject } of pending.values()) reject(cause);
    pending.clear();
  }

  worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if ("error" in data) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stop(
      new DOMException(
        "The file worker stopped. Reopen the file to try again.",
        "NetworkError",
      ),
    );
  };
  worker.onmessageerror = () =>
    stop(
      new DOMException(
        "The file worker could not return results. Reopen the file to try again.",
        "NetworkError",
      ),
    );

  return {
    stop: () => stop(new DOMException("The file was closed.", "AbortError")),
    async execute(request: AbaFileRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const id = ++nextId;
      let cancel: (() => void) | undefined;
      const response = new Promise<AbaFileResult>((resolve, reject) => {
        if (closed) {
          reject(
            new Error(
              "The file worker is unavailable. Reopen the file to try again.",
            ),
          );
          return;
        }
        pending.set(id, { resolve, reject });
        cancel = () => {
          pending.delete(id);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          worker.postMessage({ id, request } satisfies WorkerRequest);
        } catch {
          stop(
            new DOMException("The file worker is unavailable.", "NetworkError"),
          );
        }
      });
      try {
        return await response;
      } finally {
        if (cancel) signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

export function openAbaFile(file: File) {
  const abort = new AbortController();
  let worker: ReturnType<typeof startWorker> | undefined;
  let execute: ReturnType<typeof createAbaFileSession> | undefined;

  const opened = (async () => {
    try {
      worker = startWorker();
    } catch {
      // Keep opening files if a browser or hosting policy blocks workers.
    }
    if (worker) {
      try {
        return await worker.execute({ type: "open", file });
      } catch (cause) {
        if (!(cause instanceof DOMException) || cause.name !== "NetworkError") {
          throw cause;
        }
        worker = undefined;
      }
    }
    abort.signal.throwIfAborted();
    execute = createAbaFileSession(
      abort.signal,
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
    try {
      return await execute({ type: "open", file });
    } catch (cause) {
      abort.signal.throwIfAborted();
      throw cause instanceof RangeError ? cause : new Error(readError);
    }
  })();

  return {
    opened,
    async request<T extends AbaFileRequest>(
      request: T,
      signal?: AbortSignal,
    ): Promise<Extract<AbaFileResult, { type: T["type"] }>> {
      abort.signal.throwIfAborted();
      const result = await (worker?.execute(request, signal) ??
        execute?.(request, signal));
      abort.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!result || result.type !== request.type) throw new Error(readError);
      // The worker result echoes the request's discriminant, checked above.
      return result as Extract<AbaFileResult, { type: T["type"] }>;
    },
    close() {
      abort.abort();
      worker?.stop();
      worker = undefined;
      execute = undefined;
    },
  };
}

export type AbaFileClient = ReturnType<typeof openAbaFile>;
