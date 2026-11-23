export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthValidationError';
  }
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Email or password is incorrect');
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Refresh token is invalid or expired');
    this.name = 'InvalidRefreshTokenError';
  }
}

export class RefreshTokenReuseDetectedError extends InvalidRefreshTokenError {
  constructor() {
    super();
    this.name = 'RefreshTokenReuseDetectedError';
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication is required');
    this.name = 'UnauthenticatedError';
  }
}

export class EmailNotVerifiedError extends Error {
  constructor() {
    super('Email address must be verified before signing in');
    this.name = 'EmailNotVerifiedError';
  }
}

export class InvalidEmailVerificationTokenError extends Error {
  constructor() {
    super('Email verification token is invalid or expired');
    this.name = 'InvalidEmailVerificationTokenError';
  }
}

export class ExternalIdentityEmailConflictError extends Error {
  constructor() {
    super('This VK account uses an email that is already registered. Sign in first, then link VK');
    this.name = 'ExternalIdentityEmailConflictError';
  }
}

export class ExternalIdentityAlreadyLinkedError extends Error {
  constructor() {
    super('This VK account is already linked to another Paper Wars account');
    this.name = 'ExternalIdentityAlreadyLinkedError';
  }
}

export class ExternalIdentityEmailRequiredError extends Error {
  constructor() {
    super('VK ID did not provide an email address. Use email registration first');
    this.name = 'ExternalIdentityEmailRequiredError';
  }
}
