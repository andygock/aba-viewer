export const rawPageSize = 2048;

export function visibleText(text: string) {
  // Keep the underlying record untouched for parsing and search.
  return text.replace(
    /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu,
    (character) =>
      `⟦U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}⟧`,
  );
}

export function rawPage(raw: string, page: number) {
  // Move both sides of a page boundary before any surrogate pair it splits.
  const boundary = (index: number) =>
    /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(raw.slice(index - 1, index + 1))
      ? index - 1
      : index;

  return visibleText(
    raw.slice(
      page ? boundary(page * rawPageSize) : 0,
      boundary((page + 1) * rawPageSize),
    ),
  );
}

export function recordPreview(raw: string, limit = 80) {
  let preview = "";
  let columns = 0;

  for (const character of raw.trim()) {
    if (columns === limit) break;
    preview += character;
    columns += 1;
  }

  return preview;
}
