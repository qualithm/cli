/**
 * Renders rows as left-aligned columns separated by two spaces, header first.
 *
 * @param rows - the header row, then one row per item
 * @returns the table, one line per row
 */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ")
    )
    .map((line) => `${line}\n`)
    .join("")
}

/**
 * A cell for an optional value: the value, or `-` when it's missing.
 *
 * @param value - the value
 * @returns the cell
 */
export function dash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "-" : value
}

/**
 * A cell for an optional time, as ISO 8601, or `-` when it's missing.
 *
 * @param value - the time, as a `Date` or the API's ISO 8601 string
 * @returns the cell
 */
export function when(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-"
  }
  return typeof value === "string" ? value : value.toISOString()
}
