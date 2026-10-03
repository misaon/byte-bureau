// Bounded ring of the newest lines; the Supervisor keeps one per stream for diagnostics
export class LineBuffer {
  public dropped = 0
  private readonly items: string[] = []
  private readonly limit: number

  public constructor(limit: number) {
    this.limit = limit
  }

  public push(line: string): void {
    this.items.push(line)
    if (this.items.length > this.limit) {
      this.items.shift()
      this.dropped += 1
    }
  }

  public lines(): readonly string[] {
    return [...this.items]
  }
}
