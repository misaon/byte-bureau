export interface BoundAddress {
  readonly host: string
  readonly port: number
}

// The host and port of the address the platform prints, with or without a scheme; an IPv6 host loses its brackets
// The URL parser drops port 80, the default of the scheme
export const boundAddress = (formatted: string): BoundAddress => {
  const url = new URL(formatted.startsWith('http') ? formatted : `http://${formatted}`)
  return {
    host: url.hostname.replaceAll(/^\[|\]$/gu, ''),
    port: url.port === '' ? 80 : Number(url.port),
  }
}
