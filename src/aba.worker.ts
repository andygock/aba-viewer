import type { WorkerRequest, WorkerResult } from "./abaFileProtocol";
import { createAbaFileSession, readError } from "./abaFileSession";

const execute = createAbaFileSession();

self.addEventListener(
  "message",
  async ({ data: { id, request } }: MessageEvent<WorkerRequest>) => {
    let response: WorkerResult;
    try {
      response = { id, result: await execute(request) };
    } catch (cause) {
      response = {
        id,
        error: cause instanceof RangeError ? cause.message : readError,
      };
    }
    self.postMessage(response);
  },
);
