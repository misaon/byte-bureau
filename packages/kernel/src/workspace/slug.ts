const MAX = 40

// A git branch name for a session: bb/<kebab-case title>, or bb/s-<short session id> when the title has no letters or digits
// The first replacement drops the combining diacritical marks, U+0300 to U+036F, that NFD splits off the letters
export function branchSlug(title: string, sessionId: string): string {
  const slug = title
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, MAX)
    .replaceAll(/-+$/gu, '')
  return `bb/${slug === '' ? `s-${sessionId.slice(0, 8)}` : slug}`
}
