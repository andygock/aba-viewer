import type { AbaBatch, AbaRecord, describeFields } from "./aba";

export const pageSize = 50;

export type RecordFilter = AbaRecord["kind"] | "all" | "flagged";

export type AbaFileRequest =
  | { type: "open"; file: File }
  | { type: "batch"; index: number }
  | {
      type: "page";
      index: number;
      page: number;
      filter: RecordFilter;
      term: string;
    }
  | { type: "record"; index: number; line: number; page: number };

export type BatchDetails = Pick<AbaBatch, "count" | "issues" | "totals"> & {
  flaggedCount: number;
  reconciliation: string;
  options: { index: number; description: string }[];
};

export type RecordRowData = Omit<AbaRecord, "raw"> & {
  title: string;
  bsb: string;
  account: string;
  reference: string;
  code: string;
  amount: string;
};

export type RecordPage = { count: number; records: RecordRowData[] };

export type RecordDetails = Omit<AbaRecord, "raw"> & {
  fields: ReturnType<typeof describeFields>;
  rawPageCount: number;
  rawText: string;
};

export type AbaFileResult =
  | { type: "open"; batchCount: number }
  | ({ type: "batch" } & BatchDetails)
  | ({ type: "page" } & RecordPage)
  | ({ type: "record" } & RecordDetails);

export type WorkerRequest = { id: number; request: AbaFileRequest };
export type WorkerResult = { id: number } & (
  | { result: AbaFileResult }
  | { error: string }
);
