export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  public constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

export class InvariantError extends ApplicationError {
  public constructor(message: string) {
    super('INVARIANT_VIOLATION', message);
  }
}
