import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAba,
  describeField,
  describeFields,
  parseAba,
  readAbaFile,
  readField,
  readNamedField,
  trailerReconciliation,
} from "../src/aba.ts";
import {
  rawPage,
  rawPageSize,
  recordPreview,
  visibleText,
} from "../src/recordText.ts";

const spaces = (width) => " ".repeat(width);
const digits = (value, width) => String(value).padStart(width, "0");

const header = [
  "0",
  spaces(17),
  "01",
  "CBA",
  spaces(7),
  "Example".padEnd(26),
  "000123",
  "PAYROLL".padEnd(12),
  "290224",
  spaces(40),
].join("");

function detail(code, cents) {
  return [
    "1",
    "062-000",
    "   001234",
    "N",
    code,
    digits(cents, 10),
    "Example account".padEnd(32),
    "PAY-001".padEnd(18),
    "062-001",
    "    01234",
    "Example".padEnd(16),
    "00000000",
  ].join("");
}

function trailer(credit, debit, count) {
  return [
    "7999-999",
    spaces(12),
    digits(Math.abs(credit - debit), 10),
    digits(credit, 10),
    digits(debit, 10),
    spaces(24),
    digits(count, 6),
    spaces(40),
  ].join("");
}

test("parses all supported separators, trimmed control records and leading zeroes", () => {
  for (const ending of ["\r\n", "\n", "\r", "\n\r"]) {
    const [batch] = parseAba(
      [
        header.slice(0, 80),
        detail("53", 1234),
        trailer(1234, 0, 1).slice(0, 80),
        "",
      ].join(ending),
    );

    assert.equal(batch.records.length, 3);
    assert.deepEqual(batch.totals, { credit: 1234, debit: 0, complete: true });
    assert.deepEqual(
      batch.records.flatMap((record) => record.issues),
      [],
    );
    assert.equal(readField(batch.records[1], 9, 17), "001234");
    const fields = Object.fromEntries(
      describeFields(batch.records[1]).map(({ key, value }) => [key, value]),
    );
    assert.equal(fields.amount, "$12.34");
    assert.match(fields.code, /^53.*Pay$/);
  }
});

test("reconciles separate batches, including debit-only and self-balancing batches", () => {
  const batches = parseAba(
    [
      header,
      detail("13", 480),
      trailer(0, 480, 1),
      header,
      detail("56", 1950),
      detail("13", 1950),
      trailer(1950, 1950, 2),
    ].join("\n"),
  );

  assert.deepEqual(
    batches.map((batch) => batch.count),
    [1, 2],
  );
  assert.equal(batches[1].header.line, 4);
  assert.deepEqual(
    batches.flatMap((batch) =>
      batch.records.flatMap((record) => record.issues),
    ),
    [],
  );
});

test("retains malformed rows and avoids treating invalid cents as zero", () => {
  const [batch] = parseAba(
    [
      header.replace("290224", "290223"),
      detail("99", 1234).replace("0000001234", "00000012x4"),
      "",
      "2unknown",
      trailer(500, 0, 2).replace("0000000500", "0000000100"),
    ].join("\n"),
  );

  assert.equal(batch.totals.complete, false);
  assert.match(batch.header.issues[0], /date/);
  assert.equal(batch.records[2].raw, "");
  assert.equal(batch.records[3].kind, "unknown");
  assert.ok(batch.records[1].issues.some((issue) => issue.includes("Amount")));
  assert.ok(batch.trailer.issues.some((issue) => issue.includes("count")));
  assert.ok(batch.trailer.issues.some((issue) => issue.includes("net")));
});

test("decodes BOM-marked UTF-16 and legacy Windows-1252", () => {
  assert.equal(decodeAba(Uint8Array.of(255, 254, 48, 0)), "0");
  assert.equal(decodeAba(Uint8Array.of(254, 255, 0, 48)), "0");
  assert.equal(decodeAba(Uint8Array.of(233)), "é");
});

test("honours a UTF-8 BOM when the text is malformed", () => {
  const bom = [0xef, 0xbb, 0xbf];
  assert.equal(decodeAba(Uint8Array.of(...bom, 0x30)), "0");
  assert.throws(() => decodeAba(Uint8Array.of(...bom, 0x30, 0xe9)), TypeError);
});

test("accepts unused fields in ANZ Internet Banking direct debit exports", () => {
  const [batch] = parseAba(
    [
      `0${spaces(29)}${header.slice(30, 56)}${spaces(6)}${header.slice(62, 74)}${spaces(46)}`,
      `${detail("50", 1234).slice(0, 80)}${spaces(40)}`,
      `7${spaces(19)}${trailer(1234, 0, 1).slice(20)}`,
    ].join("\r\n"),
  );

  assert.deepEqual(
    batch.records.flatMap((record) => record.issues),
    [],
  );
  assert.equal(batch.totals.credit, 1234);
});

test("bounds the number of malformed lines before building records", () => {
  assert.throws(() => parseAba("\n".repeat(200_002)), /200,000 lines/);
});

test("reads named fields at the same columns as the original reader", () => {
  const original = detail("53", 1234);
  const raw = `${original.slice(0, 30)}😀${original.slice(31)}${"x".repeat(100_000)}`;
  const [batch] = parseAba(raw);
  const [record] = batch.records;

  assert.equal(record.raw, raw);
  assert.equal(record.width, original.length + 100_000);
  assert.equal(readNamedField(record, "title"), readField(record, 31, 62));
  assert.equal(readNamedField(record, "title"), "😀xample account");
  assert.equal(readNamedField(record, "reference"), "PAY-001");
  assert.equal(describeField(record, "amount").value, "$12.34");
  assert.equal(describeField(record, "constructor"), undefined);
  assert.equal(batch.totals.credit, 1234);
});

test("distinguishes trailer reconciliation from readable detail totals", () => {
  const transaction = detail("53", 1234);
  const [matched] = parseAba(
    [header, transaction, trailer(1234, 0, 1)].join("\n"),
  );
  const [mismatch] = parseAba(
    [header, transaction, trailer(1234, 0, 2)].join("\n"),
  );
  const [invalidTrailer] = parseAba(
    [header, transaction, trailer(1234, 0, 1).replace("000001", "00000X")].join(
      "\n",
    ),
  );
  const [missing] = parseAba([header, transaction].join("\n"));
  const [empty] = parseAba([header, trailer(0, 0, 0)].join("\n"));

  assert.equal(trailerReconciliation(matched), "Match parsed transactions");
  assert.equal(trailerReconciliation(mismatch), "Mismatch");
  assert.equal(trailerReconciliation(invalidTrailer), "Unavailable");
  assert.equal(trailerReconciliation(missing), "Missing trailer");
  assert.equal(missing.totals.credit, 1234);
  assert.equal(trailerReconciliation(empty), "Unavailable");
});

test("compares trailer figures separately from structural diagnostics", () => {
  const [batch] = parseAba(
    [detail("53", 1234), "2unrecognised", trailer(1234, 0, 1)].join("\n"),
  );

  assert.ok(batch.issues.includes("Header is missing."));
  assert.ok(batch.records[1].issues.includes("Unrecognised record type."));
  assert.equal(trailerReconciliation(batch), "Match parsed transactions");
});

test("explains incomplete totals even when the trailer is missing", () => {
  const [batch] = parseAba([header, detail("99", 1234)].join("\n"));
  assert.ok(batch.issues.includes("Trailer is missing."));
  assert.ok(
    batch.issues.some((issue) => issue.includes("totals are incomplete")),
  );
});

test("reads files using the existing decoding and rejects blank or NUL-containing text", async () => {
  const source = [header, detail("53", 1234), trailer(1234, 0, 1)].join("\r\n");
  assert.deepEqual(await readAbaFile(new Blob([source])), parseAba(source));
  for (const invalid of [" ", "1\0"]) {
    await assert.rejects(
      readAbaFile(new Blob([invalid])),
      /non-empty ABA text/,
    );
  }
});

test("shows invisible controls and preserves surrogate pairs at raw page boundaries", () => {
  assert.equal(visibleText("Café\u202E123\u200B"), "Café⟦U+202E⟧123⟦U+200B⟧");
  const prefix = "x".repeat(rawPageSize - 1);
  const raw = `${prefix}😀\u0009tail`;

  assert.equal(rawPage(raw, 0), prefix);
  assert.equal(rawPage(raw, 1), "😀⟦U+0009⟧tail");
});

test("rejects oversized files before allocating a read buffer", async () => {
  const oversized = {
    size: 16 * 1024 * 1024 + 1,
    arrayBuffer() {
      assert.fail("Oversized files must not be read.");
    },
  };

  await assert.rejects(readAbaFile(oversized), /no larger than 16 MiB/);
  await assert.rejects(readAbaFile(new Blob()), /selected file is empty/);
});

test("keeps supplementary characters intact at the preview boundary", () => {
  const prefix = "x".repeat(79);
  assert.equal(recordPreview(`  ${prefix}😀tail  `), `${prefix}😀`);
});
