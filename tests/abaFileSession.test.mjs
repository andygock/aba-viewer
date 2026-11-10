import assert from "node:assert/strict";
import test from "node:test";
import { createAbaFileSession } from "../src/abaFileSession.ts";
import { rawPageSize } from "../src/recordText.ts";

const abaFile = (source) => new File([source], "test.aba");

test("returns only the requested batch options and record page", async () => {
  const execute = createAbaFileSession();
  const lines = [
    ...Array.from({ length: 51 }, () => "0"),
    ...Array.from({ length: 51 }, (_, index) => `2Row ${index + 1}`),
  ];
  assert.deepEqual(
    await execute({ type: "open", file: abaFile(lines.join("\n")) }),
    { type: "open", batchCount: 51 },
  );

  const batch = await execute({ type: "batch", index: 50 });
  assert.deepEqual(batch.options, [{ index: 50, description: "" }]);
  assert.equal(batch.flaggedCount, 52);

  const query = { type: "page", index: 50, term: "row", filter: "unknown" };
  const first = await execute({ ...query, page: 0 });
  const second = await execute({ ...query, page: 1 });
  assert.equal(first.count, 51);
  assert.equal(first.records.length, 50);
  assert.deepEqual(
    second.records.map(({ line }) => line),
    [102],
  );
  const byLine = await execute({ ...query, term: "102", page: 0 });
  assert.deepEqual(
    byLine.records.map(({ line }) => line),
    [102],
  );
  const headers = await execute({ ...query, filter: "header", page: 0 });
  assert.equal(headers.count, 0);
});

test("searches complete records and returns bounded previews and raw pages", async () => {
  const execute = createAbaFileSession();
  const prefix = `2${"x".repeat(rawPageSize - 2)}`;
  const raw = `${prefix}😀\tTail`;
  await execute({ type: "open", file: abaFile(raw) });
  const page = await execute({
    type: "page",
    index: 0,
    page: 0,
    filter: "all",
    term: "tail",
  });
  assert.equal(page.records[0].title, prefix.slice(0, 80));
  assert.ok(!Object.hasOwn(page.records[0], "raw"));
  assert.equal(page.records[0].width, raw.length - 1);

  const record = { type: "record", index: 0, line: 1 };
  const start = await execute({ ...record, page: 0 });
  const end = await execute({ ...record, page: 1 });
  assert.equal(start.rawPageCount, 2);
  assert.equal(start.rawText, prefix);
  assert.equal(end.rawText, "😀⟦U+0009⟧Tail");
});

test("cooperative fallback cancels parsing and searches at yield points", async () => {
  const source = `2${"x".repeat(260)}\n`.repeat(1024);
  const closed = new AbortController();
  const read = createAbaFileSession(closed.signal, async () => closed.abort());
  await assert.rejects(read({ type: "open", file: abaFile(source) }), {
    name: "AbortError",
  });

  const obsolete = new AbortController();
  let cancelSearch = false;
  const execute = createAbaFileSession(undefined, async () => {
    if (cancelSearch) obsolete.abort();
  });
  await execute({ type: "open", file: abaFile(source) });
  cancelSearch = true;
  const query = { type: "page", index: 0, page: 0, filter: "all", term: "x" };
  await assert.rejects(execute(query, obsolete.signal), { name: "AbortError" });
  assert.equal((await execute(query)).count, 1024);
});
