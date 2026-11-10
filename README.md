# ABA Viewer

Use Node.js 22.12 or later and the pnpm version declared in `package.json`. Run `pnpm install` and `pnpm dev`, then open the local URL printed by Vite. Drop a file onto the app or choose **Open file**. Select the record-type button in the **Record** column to inspect its fields, then expand **Raw record** to inspect the line. Click outside the inspector, press Escape or use **Close** to dismiss it. Use **Close file** to clear the current file. If a replacement fails to open, the previous file stays open.

Files are decoded, parsed and searched locally in the browser. When available, a Web Worker keeps the parsed file and returns the requested results to the viewer. The viewer accepts files up to 16 MiB and 200,000 lines and shows records in pages of 50. Use **Go to batch** to jump within files containing more than 50 batches. Long raw records are paginated, and invisible control characters appear as Unicode code points.

Use a modern browser with native modal dialogs and CSS support for `oklch()` and `color-mix()`. The production build currently targets Chrome and Edge 111, Firefox 114 and Safari 16.4 or later.

## Format coverage

- Type 0 headers, type 1 transactions and type 7 trailers. Consecutive batches are displayed separately. Unknown records remain available as raw lines.
- Standard 120-column records and 80-column headers and trailers where the reserved tail is omitted.
- CRLF, LFCR, LF and CR separators. UTF-8, BOM-marked UTF-16 and Windows-1252 fallback accommodate exports beyond standard ASCII. A BOM declares the encoding, so invalid text in a BOM-marked file is rejected.
- Transaction codes 13 and 50–57, trace details, account identifiers with leading zeroes, withholding indicators and amounts, and unsigned trailer totals.
- Credit and debit totals include balancing entries. A contra entry uses an ordinary transaction record and cannot reliably be identified from its format alone. An unreadable amount or unsupported transaction code makes the parsed totals incomplete.
- **Trailer count and totals** reports whether the declared figures agree with the parsed transactions. Structural and record warnings are shown separately. Files with unrecognised records can still be opened for inspection. Acceptance rules vary by bank and channel.

## Format references

- [AusPayNet BECS Procedures](https://www.auspaynet.com.au/sites/default/files/2025-07/BECS%20Procedures%20-%20Version%20E071%20-%20Effective%201%20September%202025%20-%20Public.pdf) for transaction codes and record layouts.
- [CommBank Direct Entry specification](https://docs.commbank.com.au/sftp/direct-entry/file-spec/) for optional control-record padding and contra entries.
- [Westpac Direct Entry specification](https://paymentsplus.westpac.com.au/docs/downloads/aba.pdf) for separator variants, trace fields and withholding indicators.
- [ANZ Internet Banking direct debits](https://www.anz.com.au/support/business/internet-banking/direct-debits/upload-file/) for channel-specific blank fields and unbalanced batches.
- [BOQ Direct Entry specification](https://www.boq.com.au/content/dam/boq/files/help-and-support/internet-and-apps/direct-entry-file-specification.pdf) for padding and restrictions on multi-batch files.
- [NAB Direct Link payment file errors](https://www.nab.com.au/business/online-banking/nab-direct-link/help/payments-issues) for balancing requirements.
- [Cemtex ABA format details](https://www.cemtexaba.com/aba-format/cemtex-aba-file-format-details/) for field examples.

## Checks

- `pnpm check` runs Biome formatting and recommended lint checks.
- `pnpm test` runs the parser, file session and text display tests.
- `pnpm build` type-checks the app and worker and builds the static site to `dist/` with relative asset URLs for root or subdirectory hosting. The Wrangler configuration also serves assets from `dist/`.
