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

export class ExternalIdentityAlreadyLinkedError extends Error {
  constructor() {
    super('This VK account is already linked to another Paper Wars account');
    this.name = 'ExternalIdentityAlreadyLinkedError';
  }
}

export class DisplayNameAlreadyTakenError extends Error {
  constructor() {
    super('This nickname is already in use');
    this.name = 'DisplayNameAlreadyTakenError';
  }
}
