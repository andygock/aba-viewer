type Field = readonly [
  label: string,
  start: number,
  end: number,
  format?: "money" | "date",
];

const layouts = {
  header: {
    type: ["Record type", 1, 1],
    reservedA: ["Reserved", 2, 18],
    sequence: ["Reel sequence", 19, 20],
    institution: ["Financial institution", 21, 23],
    reservedB: ["Reserved", 24, 30],
    user: ["File user", 31, 56],
    userId: ["Direct Entry user ID", 57, 62],
    description: ["Description", 63, 74],
    date: ["Processing date", 75, 80, "date"],
    reservedC: ["Reserved", 81, 120],
  },
  detail: {
    type: ["Record type", 1, 1],
    bsb: ["BSB", 2, 8],
    account: ["Account number", 9, 17],
    indicator: ["Indicator", 18, 18],
    code: ["Transaction code", 19, 20],
    amount: ["Amount", 21, 30, "money"],
    title: ["Account title", 31, 62],
    reference: ["Lodgement reference", 63, 80],
    traceBsb: ["Trace BSB", 81, 87],
    traceAccount: ["Trace account", 88, 96],
    remitter: ["Remitter", 97, 112],
    tax: ["Withholding tax", 113, 120, "money"],
  },
  trailer: {
    type: ["Record type", 1, 1],
    bsb: ["BSB filler", 2, 8],
    reservedA: ["Reserved", 9, 20],
    net: ["Net total", 21, 30, "money"],
    credit: ["Credit total", 31, 40, "money"],
    debit: ["Debit total", 41, 50, "money"],
    reservedB: ["Reserved", 51, 74],
    count: ["Detail record count", 75, 80],
    reservedC: ["Reserved", 81, 120],
  },
} as const satisfies Record<string, Record<string, Field>>;

const layoutEntries = {
  header: Object.entries<Field>(layouts.header),
  detail: Object.entries<Field>(layouts.detail),
  trailer: Object.entries<Field>(layouts.trailer),
};

const transactionCodes = new Map([
  ["13", "Debit"],
  ["50", "General credit"],
  ["51", "Government security interest"],
  ["52", "Family payment"],
  ["53", "Pay"],
  ["54", "Pension"],
  ["55", "Allotment"],
  ["56", "Dividend"],
  ["57", "Debenture or note interest"],
]);

const indicators = new Map([
  ["N", "New or changed account details"],
  ["W", "Dividend with a double tax agreement"],
  ["X", "Dividend without a double tax agreement"],
  ["Y", "Interest paid to a non-resident"],
]);

export interface AbaRecord {
  line: number;
  kind: keyof typeof layouts | "unknown";
  raw: string;
  width: number;
  issues: string[];
}

export interface AbaBatch {
  records: AbaRecord[];
  header?: AbaRecord;
  trailer?: AbaRecord;
  count: number;
  issues: string[];
  totals: { credit: number; debit: number; complete: boolean };
}

const bsbPattern = /^[0-9]{3}-[0-9]{3}$/;
const currency = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

export function formatMoney(cents: number) {
  return currency.format(cents / 100);
}

function unsigned(raw: string, width: number) {
  return raw.length === width && /^[0-9]+$/.test(raw) ? Number(raw) : null;
}

function validDate(raw: string) {
  if (unsigned(raw, 6) === null) return false;

  const day = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const year = Number(raw.slice(4, 6));
  // DDMMYY has no century. Use a leap-compatible cycle for the calendar check.
  const date = new Date(Date.UTC(2000 + year, month - 1, day));
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1;
}

function columns(raw: string, start: number, end: number) {
  // Count code points for non-standard Unicode text without splitting a surrogate pair.
  if (!/[\uD800-\uDBFF]/.test(raw.slice(0, end))) {
    return raw.slice(start - 1, end);
  }

  let column = 0;
  let value = "";
  for (const character of raw) {
    column += 1;
    if (column >= start) value += character;
    if (column === end) break;
  }
  return value;
}

function trimField(value: string) {
  return value.replace(/^ +| +$/g, "");
}

/** Reads one-based inclusive fixed-width columns, preserving identifier zeroes. */
export function readField(record: AbaRecord, start: number, end: number) {
  return trimField(columns(record.raw, start, end));
}

function findField(record: AbaRecord, key: string): Field | undefined {
  if (record.kind === "unknown") return undefined;
  const fields: Partial<Record<string, Field>> = layouts[record.kind];
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

export function readNamedField(record: AbaRecord, key: string) {
  const field = findField(record, key);
  return field ? readField(record, field[1], field[2]) : "";
}

function readUnsignedField(record: AbaRecord, [, start, end]: Field) {
  return unsigned(columns(record.raw, start, end), end - start + 1);
}

function formatField(record: AbaRecord, key: string, field: Field) {
  const [label, start, end, format] = field;
  const raw = columns(record.raw, start, end);
  const value = trimField(raw);
  const cents = format === "money" ? unsigned(raw, end - start + 1) : null;
  const description =
    key === "code"
      ? transactionCodes.get(value)
      : key === "indicator"
        ? indicators.get(value)
        : undefined;
  let display = value;

  if (cents !== null) display = formatMoney(cents);
  if (format === "date" && validDate(value))
    display = value.replace(/^(..)(..)(..)$/, "$1/$2/$3");
  if (description) display = `${value} · ${description}`;

  return { key, label, start, end, value: display };
}

export function describeField(record: AbaRecord, key: string) {
  const field = findField(record, key);
  return field && formatField(record, key, field);
}

export function describeFields(record: AbaRecord) {
  if (record.kind === "unknown") return [];
  return layoutEntries[record.kind].map(([key, field]) =>
    formatField(record, key, field),
  );
}

function inspectRecord(raw: string, line: number): AbaRecord {
  const kind =
    raw[0] === "0"
      ? "header"
      : raw[0] === "1"
        ? "detail"
        : raw[0] === "7"
          ? "trailer"
          : "unknown";
  const width = raw.replace(/[\uD800-\uDBFF](?=[\uDC00-\uDFFF])/g, "").length;
  const issues: string[] = [];
  const record: AbaRecord = { raw, line, kind, width, issues };

  if (kind === "unknown") {
    issues.push(raw.trim() ? "Unrecognised record type." : "Blank record.");
    return record;
  }

  // Some CommBank channels allow the last 40 reserved columns to be omitted.
  if (width !== 120 && !(width === 80 && kind !== "detail")) {
    issues.push(
      `Record has ${width} columns. Expected 120${kind === "detail" ? "" : " or 80"}.`,
    );
  }
  if (/[^ -~]/.test(raw)) {
    issues.push("Contains characters outside printable ASCII.");
  }

  for (const [key, [label, start, end, format]] of layoutEntries[kind]) {
    const value = columns(raw, start, end);
    if (key.startsWith("reserved") && value.trim())
      issues.push(`${label} columns ${start}–${end} contain data.`);

    // Some ANZ channels leave header metadata and unused withholding fields blank.
    if (
      value.length === end - start + 1 &&
      /^ +$/.test(value) &&
      (key === "sequence" ||
        key === "userId" ||
        key === "date" ||
        key === "tax")
    ) {
      continue;
    }

    if (
      (format === "money" ||
        key === "count" ||
        key === "userId" ||
        key === "sequence") &&
      unsigned(value, end - start + 1) === null
    ) {
      issues.push(`${label} must contain ${end - start + 1} digits.`);
    }
    if (format === "date" && !validDate(value))
      issues.push("Processing date is not a valid DDMMYY date.");
  }

  if (kind === "detail") {
    if (!bsbPattern.test(readNamedField(record, "bsb")))
      issues.push("BSB must use the format NNN-NNN.");
    const traceBsb = readNamedField(record, "traceBsb");
    if (traceBsb && !bsbPattern.test(traceBsb))
      issues.push("Trace BSB must use the format NNN-NNN.");
    if (!readNamedField(record, "account"))
      issues.push("Account number is blank.");
    if (!readNamedField(record, "title"))
      issues.push("Account title is blank.");
    if (!transactionCodes.has(readNamedField(record, "code")))
      issues.push("Unrecognised transaction code.");
    const indicator = readNamedField(record, "indicator");
    if (indicator && !indicators.has(indicator))
      issues.push("Unrecognised indicator.");
  }

  if (kind === "trailer") {
    const filler = readNamedField(record, "bsb");
    if (filler && filler !== "999-999")
      issues.push("Trailer BSB filler differs from 999-999.");
  }

  return record;
}

function checkTrailer(batch: AbaBatch, trailer: AbaRecord) {
  const { totals } = batch;
  const count = readUnsignedField(trailer, layouts.trailer.count);
  const credit = readUnsignedField(trailer, layouts.trailer.credit);
  const debit = readUnsignedField(trailer, layouts.trailer.debit);
  const net = readUnsignedField(trailer, layouts.trailer.net);

  return {
    count: count === null ? null : count === batch.count,
    credit:
      credit === null || !totals.complete ? null : credit === totals.credit,
    debit: debit === null || !totals.complete ? null : debit === totals.debit,
    net:
      net === null || credit === null || debit === null
        ? null
        : net === Math.abs(credit - debit),
  };
}

export function trailerReconciliation(batch: AbaBatch) {
  if (!batch.trailer) return "Missing trailer";
  const checks = Object.values(checkTrailer(batch, batch.trailer));
  if (checks.includes(false)) return "Mismatch";
  if (batch.count === 0 || checks.includes(null)) return "Unavailable";
  return "Match parsed transactions";
}

function completeBatch(batch: AbaBatch) {
  if (!batch.header) batch.issues.push("Header is missing.");
  if (batch.count === 0) batch.issues.push("No detail records.");
  if (!batch.totals.complete) {
    batch.issues.push(
      "Detail totals are incomplete because an amount or transaction code could not be read.",
    );
  }
  if (!batch.trailer) {
    batch.issues.push("Trailer is missing.");
    return;
  }

  const { trailer } = batch;
  const checks = checkTrailer(batch, trailer);

  if (checks.count === false)
    trailer.issues.push(
      "Declared count differs from the number of detail records.",
    );
  if (checks.credit === false)
    trailer.issues.push("Declared credits differ from detail records.");
  if (checks.debit === false)
    trailer.issues.push("Declared debits differ from detail records.");
  if (checks.net === false) {
    trailer.issues.push(
      "Declared net differs from the unsigned difference between declared credits and debits.",
    );
  }
}

function* parseAbaBatches(source: string): Generator<void, AbaBatch[]> {
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\n\r|\r|\n/, 200_002);
  if (lines.at(-1) === "") lines.pop();
  // Bound malformed inputs with millions of short lines before allocating record objects.
  if (lines.length > 200_000)
    throw new RangeError("The file contains more than 200,000 lines.");

  const batches: AbaBatch[] = [];
  let batch: AbaBatch | undefined;

  for (const [index, raw] of lines.entries()) {
    if (index && index % 512 === 0) yield;
    const record = inspectRecord(raw, index + 1);

    if (
      !batch ||
      record.kind === "header" ||
      (batch.trailer && record.kind !== "unknown")
    ) {
      if (batch) completeBatch(batch);
      batch = {
        records: [],
        count: 0,
        issues: [],
        totals: { credit: 0, debit: 0, complete: true },
      };
      batches.push(batch);
    }

    batch.records.push(record);
    if (record.kind === "header") batch.header = record;
    if (record.kind === "trailer") batch.trailer = record;
    if (record.kind !== "detail") continue;

    batch.count += 1;
    const amount = readUnsignedField(record, layouts.detail.amount);
    const code = readNamedField(record, "code");
    if (amount === null || !transactionCodes.has(code)) {
      batch.totals.complete = false;
    } else {
      batch.totals[code === "13" ? "debit" : "credit"] += amount;
    }
  }

  if (batch) completeBatch(batch);
  return batches;
}

/** Parses ABA text for inspection and keeps recoverable records and their original lines. */
export function parseAba(source: string): AbaBatch[] {
  const parser = parseAbaBatches(source);
  let step = parser.next();
  while (!step.done) step = parser.next();
  return step.value;
}

/** Decodes BOM-marked exports and falls back to Windows-1252 for legacy single-byte text. */
export function decodeAba(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const maxFileBytes = 16 * 1024 * 1024;

export function abaFileSizeError(size: number) {
  if (size === 0) return "The selected file is empty.";
  if (size > maxFileBytes) return "Choose a file no larger than 16 MiB.";
}

export async function readAbaFile(
  file: Blob,
  signal?: AbortSignal,
  yieldToUi?: () => Promise<void>,
) {
  const sizeError = abaFileSizeError(file.size);
  if (sizeError) throw new RangeError(sizeError);

  signal?.throwIfAborted();
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  const source = decodeAba(new Uint8Array(buffer));
  if (!source.trim() || source.includes("\0")) {
    throw new RangeError("Choose a non-empty ABA text file.");
  }
  if (!yieldToUi) return parseAba(source);

  const parser = parseAbaBatches(source);
  let step = parser.next();
  while (!step.done) {
    await yieldToUi();
    signal?.throwIfAborted();
    step = parser.next();
  }
  return step.value;
}
