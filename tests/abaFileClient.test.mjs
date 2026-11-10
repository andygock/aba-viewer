import assert from "node:assert/strict";
import test from "node:test";
import { openAbaFile } from "../src/abaFileClient.ts";

class TestWorker {
  static instance;
  messages = [];
  terminated = false;

  constructor() {
    TestWorker.instance = this;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  respond(id, result) {
    this.onmessage({ data: { id, result } });
  }

  terminate() {
    this.terminated = true;
  }
}

function useTestWorker(t) {
  const original = globalThis.Worker;
  globalThis.Worker = TestWorker;
  t.after(() => {
    if (original) globalThis.Worker = original;
    else delete globalThis.Worker;
  });
}

const file = () => new File(["2Example"], "test.aba");
const page = { type: "page", index: 0, page: 0, filter: "all", term: "" };

test("ignores cancelled replies and rejects outstanding requests when closed", async (t) => {
  useTestWorker(t);
  const client = openAbaFile(file());
  const worker = TestWorker.instance;
  worker.respond(worker.messages[0].id, { type: "open", batchCount: 1 });
  await client.opened;

  const abort = new AbortController();
  const obsolete = client.request(page, abort.signal);
  const current = client.request({ ...page, term: "example" });
  const [, first, second] = worker.messages;
  abort.abort();
  await assert.rejects(obsolete, { name: "AbortError" });
  worker.respond(first.id, { type: "page", count: 0, records: [] });
  worker.respond(second.id, { type: "page", count: 1, records: [] });
  assert.equal((await current).count, 1);

  const pending = client.request(page);
  client.close();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(client.request(page), { name: "AbortError" });
  assert.equal(worker.terminated, true);
});

test("uses the local session if the worker fails to start", async (t) => {
  useTestWorker(t);
  const client = openAbaFile(file());
  t.after(() => client.close());
  const worker = TestWorker.instance;
  worker.onerror({ preventDefault() {} });
  assert.deepEqual(await client.opened, { type: "open", batchCount: 1 });
  assert.equal((await client.request(page)).records[0].title, "2Example");
  assert.equal(worker.terminated, true);
});

test("propagates a file rejection from the worker", async (t) => {
  useTestWorker(t);
  const client = openAbaFile(file());
  t.after(() => client.close());
  const worker = TestWorker.instance;
  const { id } = worker.messages[0];
  worker.onmessage({ data: { id, error: "Invalid ABA text." } });
  await assert.rejects(client.opened, /Invalid ABA text/);
});
