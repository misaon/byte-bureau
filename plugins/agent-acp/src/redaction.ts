const REDACTED = '[redacted]'

// Every whole occurrence of a secret in a text is replaced
export const redacted = (text: string, secrets: readonly string[]): string => {
  let told = text
  for (const secret of secrets) {
    told = told.replaceAll(secret, REDACTED)
  }
  return told
}

// How much of the end of a text begins a secret, which is what a cut through the secret leaves
const cutSecretLength = (text: string, secret: string): number => {
  let length = Math.min(secret.length - 1, text.length)
  while (length > 0 && !text.endsWith(secret.slice(0, length))) {
    length -= 1
  }
  return length
}

// A text cut to a limit with no secret in it, whole or the part of one the cut ran through
export const cutRedacted = (text: string, limit: number, secrets: readonly string[]): string => {
  const cut = redacted(text.slice(0, limit), secrets)
  if (text.length <= limit) {
    return cut
  }
  const left = Math.max(0, ...secrets.map((secret) => cutSecretLength(cut, secret)))
  return left === 0 ? cut : `${cut.slice(0, cut.length - left)}${REDACTED}`
}
