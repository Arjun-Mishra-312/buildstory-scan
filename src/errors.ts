export class ScannerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ScannerError";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ScannerError) {
    return `${error.code}: ${error.message}`;
  }
  return "UNEXPECTED_ERROR: The scanner could not complete. No source or transcript data was printed.";
}
