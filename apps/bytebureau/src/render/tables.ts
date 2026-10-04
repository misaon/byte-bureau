// A cell is told on the one line it belongs to: the title of an ask may hold the lines of a command
const flat = (cell: string): string =>
  /[\r\n]/u.test(cell)
    ? cell
        .split(/\r\n|[\r\n]/u)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ')
    : cell

// The widest cell of every column, over all the rows, however many cells a row has
const widthsOf = (rows: readonly (readonly string[])[]): number[] => {
  const widths: number[] = []
  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    }
  }
  return widths
}

// Plain columns for a terminal: no borders, so a line stays easy to grep
export const table = (rows: readonly (readonly string[])[]): string[] => {
  const cells = rows.map((row) => row.map((cell) => flat(cell)))
  const widths = widthsOf(cells)
  return cells.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}
