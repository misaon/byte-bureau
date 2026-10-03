/** What decodeEventPayload throws: the type is not in the catalogue, or the payload does not fit its schema. */
export class EventPayloadError extends Error {
  /** The wire type of the event whose payload could not be read. */
  public readonly type: string

  /**
   * @param type The wire type of the event.
   * @param message Why the payload could not be read.
   * @param options The schema failure behind it, if any.
   */
  public constructor(type: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EventPayloadError'
    this.type = type
  }
}
