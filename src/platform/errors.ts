/** Error with a stable code and an HTTP status; message is safe to show to the user. */
export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function ensure(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new PlatformError(code, message, status);
}

export const now = () => new Date().toISOString();
