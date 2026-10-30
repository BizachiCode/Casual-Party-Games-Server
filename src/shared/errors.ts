/**
 * An expected failure with an HTTP status. Its message is safe to show to players; 5xx messages are replaced unless the
 * error carries a `code` (a stable text the client branches on, such as the store's IAP_* codes).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function ensure(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new ApiError(status, message);
}
