export class CountrySetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountrySetupValidationError';
  }
}

export class CampaignSetupNotReadyError extends Error {
  constructor() {
    super('Campaign is not accepting initial country setup');
    this.name = 'CampaignSetupNotReadyError';
  }
}

export class NotActiveCampaignMemberError extends Error {
  constructor() {
    super('User is not an active member of this campaign');
    this.name = 'NotActiveCampaignMemberError';
  }
}

export class CountryAlreadyRegisteredError extends Error {
  constructor() {
    super('This campaign member already has a country');
    this.name = 'CountryAlreadyRegisteredError';
  }
}

export class SpawnAreaUnavailableError extends Error {
  constructor() {
    super('The selected 5x5 starting area is not available');
    this.name = 'SpawnAreaUnavailableError';
  }
}

export class SystemAvailabilityNotConfiguredError extends Error {
  constructor() {
    super('Existing social-system availability is not configured by this ruleset');
    this.name = 'SystemAvailabilityNotConfiguredError';
  }
}

export class OfficialSystemNotAvailableError extends Error {
  constructor() {
    super('Selected official system is not available at this starting location');
    this.name = 'OfficialSystemNotAvailableError';
  }
}

export class SocialSystemLimitReachedError extends Error {
  constructor() {
    super('The campaign already has the maximum number of player-created systems of this type');
    this.name = 'SocialSystemLimitReachedError';
  }
}

export class SocialSystemNameConflictError extends Error {
  constructor() {
    super('A social system with this name already exists in the campaign');
    this.name = 'SocialSystemNameConflictError';
  }
}

export class SocialSystemNotFoundError extends Error {
  constructor() {
    super('Social system was not found in this campaign');
    this.name = 'SocialSystemNotFoundError';
  }
}

export class SocialSystemAdminRequiredError extends Error {
  constructor() {
    super('Administrator privileges are required to review social systems');
    this.name = 'SocialSystemAdminRequiredError';
  }
}

export class SocialSystemReviewConflictError extends Error {
  constructor() {
    super('Only pending social systems can be reviewed during initial setup');
    this.name = 'SocialSystemReviewConflictError';
  }
}
