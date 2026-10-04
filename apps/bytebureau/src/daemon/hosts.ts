import { isIPv4, isIPv6 } from 'node:net'

// The one spelling a URL gives an IPv6 address: 0:0:0:0:0:0:0:1 is ::1, ::ffff:127.0.0.1 is ::ffff:7f00:1
const canonicalV6 = (address: string): string =>
  new URL(`http://[${address}]`).hostname.slice(1, -1)

// ::1, or an address of 127.0.0.0/8 written as an IPv4-mapped IPv6 one
const LOOPBACK_V6 = /^(?:::1|::ffff:7f[\da-f]{2}:[\da-f]{1,4})$/u

// The loopback name, and every address of 127.0.0.0/8 and of ::1, however written
export const isLoopback = (host: string): boolean => {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIPv6(bare)) {
    return LOOPBACK_V6.test(canonicalV6(bare))
  }
  return bare.toLowerCase() === 'localhost' || (isIPv4(bare) && bare.startsWith('127.'))
}

const WILDCARDS: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' }

// The host clients use for a daemon bound to it: one bound to every interface is reached through the loopback of its family
// A wildcard address is no destination everywhere: Windows refuses to connect to it
export const clientHost = (bound: string): string => WILDCARDS[bound] ?? bound
