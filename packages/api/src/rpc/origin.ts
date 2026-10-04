import { Option } from 'effect'
import { Headers } from 'effect/http'

// The names a page of the daemon itself is served under on this machine; the parser keeps the brackets of an IPv6 address
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

const DEFAULT_PORT: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' }

// The port a URL names, or the one its scheme implies
const portOf = (url: URL): string =>
  url.port === '' ? (DEFAULT_PORT[url.protocol] ?? '') : url.port

// A page on a loopback name and on the port the request came to is the daemon's own (the embedded UI of SP2)
// The name in the Host header is never trusted: a page that rebinds its own name to the loopback sends that name as well
const isOwnPage = (page: URL, host: string | undefined): boolean => {
  const served = host === undefined ? null : URL.parse(`http://${host}`)
  return served !== null && LOOPBACK.has(page.hostname) && portOf(page) === portOf(served)
}

// A browser says where it comes from: a listed origin or the daemon's own page may open the socket
// A client without an Origin (the CLI, Node, Bun) is no browser; an Origin that is no URL is turned away
export const originAllowed = (headers: Headers.Headers, origins: readonly string[]): boolean => {
  const origin = Option.getOrUndefined(Headers.get(headers, 'origin'))
  if (origin === undefined || origins.includes(origin)) {
    return true
  }
  const page = URL.parse(origin)
  return page !== null && isOwnPage(page, Option.getOrUndefined(Headers.get(headers, 'host')))
}
