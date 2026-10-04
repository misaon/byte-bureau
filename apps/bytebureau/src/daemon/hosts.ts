// The loopback names, and every address of 127.0.0.0/8
export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host.startsWith('127.')

const WILDCARDS: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' }

// The host clients use for a daemon bound to it: one bound to every interface is reached through the loopback of its family
// A wildcard address is no destination everywhere: Windows refuses to connect to it
export const clientHost = (bound: string): string => WILDCARDS[bound] ?? bound
