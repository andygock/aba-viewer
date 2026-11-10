import {
  type AbaBatch,
  type AbaRecord,
  describeField,
  describeFields,
  readAbaFile,
  readNamedField,
  trailerReconciliation,
} from "./aba.ts";
import {
  type AbaFileRequest,
  type AbaFileResult,
  pageSize,
  type RecordFilter,
  type RecordRowData,
} from "./abaFileProtocol.ts";
import { rawPage, rawPageSize, recordPreview } from "./recordText.ts";

export const readError = "The file could not be read as ABA text.";

function rowPreview(record: AbaRecord): RecordRowData {
  const { kind, line, issues, width, raw } = record;
  const detail = kind === "detail";
  const title = detail
    ? readNamedField(record, "title")
    : kind === "header"
      ? readNamedField(record, "description")
      : kind === "trailer"
        ? "Declared file totals"
        : recordPreview(raw);

  return {
    kind,
    line,
    issues,
    width,
    title,
    bsb: detail ? readNamedField(record, "bsb") : "",
    account: readNamedField(record, "account"),
    reference: readNamedField(record, "reference"),
    code: readNamedField(record, "code"),
    amount: detail ? (describeField(record, "amount")?.value ?? "") : "",
  };
}

export function createAbaFileSession(
  signal?: AbortSignal,
  yieldToUi?: () => Promise<void>,
) {
  let batches: AbaBatch[] = [];
  let matches:
    | {
        index: number;
        filter: RecordFilter;
        term: string;
        records: AbaRecord[];
      }
    | undefined;

  return async (
    request: AbaFileRequest,
    requestSignal?: AbortSignal,
  ): Promise<AbaFileResult> => {
    signal?.throwIfAborted();
    requestSignal?.throwIfAborted();
    if (request.type === "open") {
      batches = await readAbaFile(request.file, signal, yieldToUi);
      matches = undefined;
      return { type: "open", batchCount: batches.length };
    }

    const batch = batches[request.index];
    if (!batch) throw new RangeError("The selected batch is unavailable.");

    if (request.type === "batch") {
      const start = Math.floor(request.index / pageSize) * pageSize;
      const { count, issues, totals } = batch;
      return {
        type: "batch",
        count,
        issues,
        totals,
        flaggedCount: batch.records.reduce(
          (count, record) => count + Number(record.issues.length > 0),
          0,
        ),
        reconciliation: trailerReconciliation(batch),
        options: batches
          .slice(start, start + pageSize)
          .map(({ header }, offset) => ({
            index: start + offset,
            description: header ? readNamedField(header, "description") : "",
          })),
      };
    }

    if (request.type === "record") {
      // Records retain their original line numbers and are contiguous within a batch.
      const record = batch.records[request.line - batch.records[0].line];
      if (!record) throw new RangeError("The selected record is unavailable.");
      const { kind, line, issues, width, raw } = record;
      return {
        type: "record",
        kind,
        line,
        issues,
        width,
        fields: describeFields(record),
        rawPageCount: Math.max(1, Math.ceil(raw.length / rawPageSize)),
        rawText: rawPage(raw, request.page),
      };
    }

    const { index, filter, term, page } = request;
    let records = batch.records;
    if (filter !== "all" || term) {
      if (
        matches?.index === index &&
        matches.filter === filter &&
        matches.term === term
      ) {
        records = matches.records;
      } else {
        records = [];
        let work = 0;
        for (const record of batch.records) {
          if (yieldToUi) {
            work += record.raw.length + 1;
            if (work >= 128 * 1024) {
              await yieldToUi();
              signal?.throwIfAborted();
              requestSignal?.throwIfAborted();
              work = 0;
            }
          }
          const inFilter =
            filter === "all" ||
            filter === record.kind ||
            (filter === "flagged" && record.issues.length > 0);
          if (
            inFilter &&
            (!term ||
              String(record.line) === term ||
              record.raw.toLowerCase().includes(term))
          ) {
            records.push(record);
          }
        }
        matches = { index, filter, term, records };
      }
    }

    const start = page * pageSize;
    return {
      type: "page",
      count: records.length,
      records: records.slice(start, start + pageSize).map(rowPreview),
    };
  };
}
