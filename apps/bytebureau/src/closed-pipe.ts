/**
 * A reader of the output that went away, as head does once it has its lines, is no failure of the command: what is left
 * to write goes nowhere, without a word. Any other failure of the stream goes on as one nobody caught.
 */
export const quietOnClosedPipe = (error: Error): void => {
  if (Reflect.get(error, 'code') !== 'EPIPE') {
    throw error
  }
}
