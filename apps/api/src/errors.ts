export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Not found is used for resources the caller does not own, to avoid revealing that they exist. */
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
