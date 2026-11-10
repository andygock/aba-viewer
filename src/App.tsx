import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import styles from "./App.module.css";
import { abaFileSizeError, formatMoney } from "./aba";
import { type AbaFileClient, openAbaFile } from "./abaFileClient";
import {
  type AbaFileRequest,
  type AbaFileResult,
  type BatchDetails,
  pageSize,
  type RecordFilter,
  type RecordRowData,
} from "./abaFileProtocol";
import { visibleText } from "./recordText";

const searchDelay = 200;
const githubUrl = "https://github.com/andygock/aba-viewer";
const kinds = {
  header: "Header",
  detail: "Detail",
  trailer: "Trailer",
  unknown: "Unknown",
};

function hasFiles(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function App() {
  const input = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbaFileClient>(null);
  const active = useRef<AbaFileClient>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<{
    id: number;
    name: string;
    client: AbaFileClient;
    batchCount: number;
  }>();
  const nextFileId = useRef(0);

  useEffect(() => {
    return () => {
      pending.current?.close();
      pending.current = null;
      active.current?.close();
    };
  }, []);

  function cancelRead() {
    pending.current?.close();
    pending.current = null;
    setLoading(false);
  }

  function closeFile() {
    cancelRead();
    active.current?.close();
    active.current = null;
    setFile(undefined);
    setError("");
    openButton.current?.focus();
  }

  async function openFile(candidate: File) {
    cancelRead();
    const sizeError = abaFileSizeError(candidate.size);
    setError(sizeError ?? "");
    if (sizeError) {
      return;
    }

    setLoading(true);

    const client = openAbaFile(candidate);
    pending.current = client;
    try {
      const result = await client.opened;
      if (pending.current !== client) return;
      if (result.type !== "open")
        throw new Error("The file could not be opened.");
      active.current?.close();
      active.current = client;
      setFile({
        id: ++nextFileId.current,
        name: candidate.name,
        client,
        batchCount: result.batchCount,
      });
    } catch (cause) {
      if (pending.current !== client) return;
      client.close();
      setError(errorMessage(cause, "The file could not be opened."));
    } finally {
      if (pending.current === client) {
        pending.current = null;
        setLoading(false);
      }
    }
  }

  function dropFile(event: DragEvent) {
    if (!hasFiles(event)) return;

    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    const [candidate] = event.dataTransfer.files;
    if (event.dataTransfer.files.length === 1 && candidate) {
      void openFile(candidate);
    } else {
      cancelRead();
      setError("Drop one ABA file at a time.");
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: File dropping supplements the keyboard-accessible Open file button.
    <div
      className={styles.shell}
      data-dragging={dragging}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={dropFile}
    >
      <header className={styles.topbar}>
        <h1>ABA Viewer</h1>
        <input
          ref={input}
          type="file"
          accept=".aba,.txt,text/plain"
          hidden
          onChange={(event) => {
            const candidate = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (candidate) void openFile(candidate);
          }}
        />
        <div className={styles.fileActions}>
          {file && (
            <button type="button" onClick={closeFile}>
              Close file
            </button>
          )}
          <button
            ref={openButton}
            type="button"
            onClick={() => input.current?.click()}
          >
            Open file
          </button>
        </div>
      </header>

      <main className={styles.main} aria-busy={loading}>
        {error && (
          <p className={styles.error} role="alert">
            {error} {file && "The previously opened file remains open."}
          </p>
        )}
        {loading && <p role="status">Reading file…</p>}
        {file ? (
          <FileBrowser
            key={file.id}
            name={file.name}
            client={file.client}
            batchCount={file.batchCount}
          />
        ) : (
          <section className={styles.dropArea} aria-label="Open an ABA file">
            <p>Drop an ABA file here</p>
            <button type="button" onClick={() => input.current?.click()}>
              Choose file
            </button>
            <small>Files are read locally in your browser.</small>
          </section>
        )}
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerLinks}>
          <span>
            © 2026 <a href="https://gock.net">Andy Gock</a>
          </span>
          <a href={githubUrl}>GitHub</a>
        </div>
        <p className={styles.disclaimer}>
          <strong>Disclaimer:</strong>
          This web site is provided as is, without any guarantee of accuracy or
          completeness. Verify the original ABA file before relying on the
          results. To the extent permitted by law, the author(s) accepts no
          liability for loss arising from use of this viewer or reliance on its
          results.
        </p>
      </footer>
      {dragging && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <span>Drop ABA file</span>
        </div>
      )}
    </div>
  );
}

function useFileRequest<T extends AbaFileRequest>(
  client: AbaFileClient,
  request: T,
) {
  type Result = Extract<AbaFileResult, { type: T["type"] }>;
  const [settled, setSettled] = useState<{
    request: T;
    result?: Result;
    error?: string;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    void client.request(request, abort.signal).then(
      (result) => {
        if (!abort.signal.aborted) setSettled({ request, result });
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) {
          setSettled({
            request,
            error: errorMessage(cause, "The file could not be displayed."),
          });
        }
      },
    );
    return () => {
      abort.abort();
    };
  }, [client, request]);
  return {
    current: settled?.request === request ? settled : undefined,
    previous: settled?.result,
  };
}

function FileBrowser({
  name,
  client,
  batchCount,
}: {
  name: string;
  client: AbaFileClient;
  batchCount: number;
}) {
  const [batchIndex, setBatchIndex] = useState(0);
  const request = useMemo(
    () => ({ type: "batch", index: batchIndex }) as const,
    [batchIndex],
  );
  const { current, previous } = useFileRequest(client, request);
  const options = previous?.options ?? [];
  const selectableIndex = options.some(({ index }) => index === batchIndex)
    ? batchIndex
    : "";

  return (
    <>
      <div className={styles.fileBar}>
        <h2>{visibleText(name)}</h2>
        {batchCount > 1 && (
          <div className={styles.toolbar}>
            {batchCount > pageSize && (
              <form
                className={styles.toolbar}
                onSubmit={(event) => {
                  event.preventDefault();
                  const position = Number(
                    new FormData(event.currentTarget).get("batch"),
                  );
                  if (
                    Number.isInteger(position) &&
                    position >= 1 &&
                    position <= batchCount
                  ) {
                    setBatchIndex(position - 1);
                  }
                }}
              >
                <label>
                  Go to batch (1–{batchCount})
                  <input
                    name="batch"
                    type="number"
                    min={1}
                    max={batchCount}
                    required
                  />
                </label>
                <button type="submit">Go</button>
              </form>
            )}
            <label>
              Batch
              <select
                value={selectableIndex}
                disabled={!options.length}
                onChange={(event) =>
                  setBatchIndex(Number(event.currentTarget.value))
                }
              >
                {selectableIndex === "" && (
                  <option value="" disabled>
                    Batch {batchIndex + 1}
                  </option>
                )}
                {options.map(({ index, description }) => (
                  <option key={index} value={index}>
                    {index + 1}
                    {description && ` · ${visibleText(description)}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {!current && <p role="status">Loading batch…</p>}
      {current?.error && (
        <p className={styles.error} role="alert">
          {current.error}
        </p>
      )}
      {current?.result && (
        <BatchBrowser
          key={batchIndex}
          batch={current.result}
          index={batchIndex}
          client={client}
        />
      )}
    </>
  );
}

function BatchBrowser({
  batch,
  index,
  client,
}: {
  batch: BatchDetails;
  index: number;
  client: AbaFileClient;
}) {
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const term = query.trim().toLowerCase();
  const [filter, setFilter] = useState<RecordFilter>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<RecordRowData>();
  const dialog = useRef<HTMLDialogElement>(null);
  const pointerStartedOnBackdrop = useRef(false);
  const { flaggedCount, issues, totals } = batch;
  const totalStatus = batch.count === 0 ? "Unavailable" : "Incomplete";
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchTerm(term), searchDelay);
    return () => window.clearTimeout(timeout);
  }, [term]);

  const request = useMemo(
    () => ({ type: "page", index, filter, term: searchTerm, page }) as const,
    [index, filter, searchTerm, page],
  );
  const { current } = useFileRequest(client, request);
  const visible = current?.result;
  const searching = searchTerm !== term || !current;

  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
  }, [selected]);

  const pageCount = Math.max(1, Math.ceil((visible?.count ?? 0) / pageSize));
  const start = page * pageSize;
  const canGoBack = !searching && page > 0;
  const canGoForward = !searching && page + 1 < pageCount;

  return (
    <>
      <dl className={styles.summary}>
        <div>
          <dt>Transactions</dt>
          <dd>{batch.count.toLocaleString("en-AU")}</dd>
        </div>
        <div>
          <dt>Parsed credits</dt>
          <dd>
            {batch.count > 0 && totals.complete
              ? formatMoney(totals.credit)
              : totalStatus}
          </dd>
        </div>
        <div>
          <dt>Parsed debits</dt>
          <dd>
            {batch.count > 0 && totals.complete
              ? formatMoney(totals.debit)
              : totalStatus}
          </dd>
        </div>
        <div>
          <dt>Flagged records</dt>
          <dd>{flaggedCount.toLocaleString("en-AU")}</dd>
        </div>
        <div>
          <dt>Trailer count and totals</dt>
          <dd>{batch.reconciliation}</dd>
        </div>
      </dl>

      {issues.length > 0 && (
        <ul className={styles.notices}>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className={styles.toolbar}>
        <label className={styles.search}>
          Search
          <input
            type="search"
            placeholder="Name, reference, account or line"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          Records
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as RecordFilter);
              setPage(0);
            }}
          >
            <option value="all">All records</option>
            <option value="detail">Transactions</option>
            <option value="header">Headers</option>
            <option value="trailer">Trailers</option>
            <option value="unknown">Unknown records</option>
            <option value="flagged">Flagged records</option>
          </select>
        </label>
      </div>

      <div className={styles.tableFrame} aria-busy={searching}>
        <table aria-label="ABA records">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Record</th>
              <th scope="col">Account title / description</th>
              <th scope="col">BSB</th>
              <th scope="col">Account</th>
              <th scope="col">Reference</th>
              <th scope="col">Code</th>
              <th scope="col" className={styles.money}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {visible?.records.map((record) => (
              <RecordRow
                key={record.line}
                record={record}
                onInspect={setSelected}
              />
            ))}
            {visible?.count === 0 && (
              <tr>
                <td colSpan={8}>No matching records.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {current?.error && (
        <p className={styles.error} role="alert">
          {current.error}
        </p>
      )}
      <div className={styles.pagination}>
        <span role="status">
          {searching
            ? "Loading records…"
            : visible &&
              (visible.count
                ? `${start + 1}–${Math.min(start + pageSize, visible.count)} of ${visible.count} records`
                : "0 records")}
        </span>
        <button
          type="button"
          aria-disabled={!canGoBack}
          onClick={() => {
            if (canGoBack) setPage(page - 1);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          aria-disabled={!canGoForward}
          onClick={() => {
            if (canGoForward) setPage(page + 1);
          }}
        >
          Next
        </button>
      </div>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the Close button already dismiss the native dialog. */}
      <dialog
        ref={dialog}
        className={styles.inspector}
        aria-labelledby="record-title"
        onClose={() => setSelected(undefined)}
        onPointerDown={(event) => {
          pointerStartedOnBackdrop.current =
            event.target === event.currentTarget &&
            isOutsideDialog(event.currentTarget, event.clientX, event.clientY);
        }}
        onClick={(event) => {
          if (
            pointerStartedOnBackdrop.current &&
            event.detail > 0 &&
            event.target === event.currentTarget &&
            isOutsideDialog(event.currentTarget, event.clientX, event.clientY)
          ) {
            event.currentTarget.close();
          }
          pointerStartedOnBackdrop.current = false;
        }}
      >
        {selected && (
          <RecordInspector record={selected} index={index} client={client} />
        )}
      </dialog>
    </>
  );
}

function isOutsideDialog(dialog: HTMLDialogElement, x: number, y: number) {
  // A backdrop event targets the dialog itself, as does a click on its padding.
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  return x < left || x >= right || y < top || y >= bottom;
}

function RecordRow({
  record,
  onInspect,
}: {
  record: RecordRowData;
  onInspect: (record: RecordRowData) => void;
}) {
  return (
    <tr>
      <td className={styles.mono}>{record.line}</td>
      <td>
        <button
          type="button"
          className={styles.recordLink}
          onClick={() => onInspect(record)}
          aria-label={`Inspect ${kinds[record.kind].toLowerCase()} on line ${record.line}`}
        >
          {kinds[record.kind]}
        </button>
      </td>
      <td>
        {visibleText(record.title) || "—"}
        {record.issues.length > 0 && (
          <span className={styles.flag}>Flagged</span>
        )}
      </td>
      <td className={styles.mono}>{visibleText(record.bsb) || "—"}</td>
      <td className={styles.mono}>{visibleText(record.account) || "—"}</td>
      <td>{visibleText(record.reference) || "—"}</td>
      <td className={styles.mono}>{visibleText(record.code) || "—"}</td>
      <td className={styles.money}>{visibleText(record.amount) || "—"}</td>
    </tr>
  );
}

function RecordInspector({
  record,
  index,
  client,
}: {
  record: RecordRowData;
  index: number;
  client: AbaFileClient;
}) {
  const [page, setPage] = useState(0);
  const { line } = record;
  const request = useMemo(
    () => ({ type: "record", index, line, page }) as const,
    [index, line, page],
  );
  const { current, previous } = useFileRequest(client, request);
  const fields = previous?.fields ?? [];
  const rawPageCount = previous?.rawPageCount ?? 1;
  const canGoBack = !!current && page > 0;
  const canGoForward = !!current && page + 1 < rawPageCount;

  return (
    <>
      <div className={styles.inspectorHeader}>
        <h3 id="record-title">
          {kinds[record.kind]} · Line {record.line}
        </h3>
        <form method="dialog">
          <button type="submit">Close</button>
        </form>
      </div>
      {current?.error && (
        <p className={styles.error} role="alert">
          {current.error}
        </p>
      )}

      {record.issues.length > 0 && (
        <ul className={styles.notices}>
          {record.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      {fields.length > 0 && (
        <table aria-label="Fixed-width fields">
          <thead>
            <tr>
              <th scope="col">Columns</th>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(({ key, label, start, end, value }) => (
              <tr key={key}>
                <td className={styles.mono}>
                  {start === end ? start : `${start}–${end}`}
                </td>
                <th scope="row">{label}</th>
                <td>{visibleText(value) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className={styles.raw}>
        <summary>Raw record · {record.width} columns</summary>
        <pre aria-busy={!current}>
          {current?.result?.rawText ?? (!current ? "Loading record…" : "")}
        </pre>
        {rawPageCount > 1 && (
          <div className={styles.pagination}>
            <span role="status">
              Raw text page {page + 1} of {rawPageCount}
            </span>
            <button
              type="button"
              aria-disabled={!canGoBack}
              onClick={() => {
                if (canGoBack) setPage(page - 1);
              }}
            >
              Previous
            </button>
            <button
              type="button"
              aria-disabled={!canGoForward}
              onClick={() => {
                if (canGoForward) setPage(page + 1);
              }}
            >
              Next
            </button>
          </div>
        )}
      </details>
    </>
  );
}
