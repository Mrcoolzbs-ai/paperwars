export class CampaignGameError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = 'CampaignGameError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class CampaignGameValidationError extends CampaignGameError {
  constructor(message: string) {
    super('INVALID_REQUEST', 400, message);
    this.name = 'CampaignGameValidationError';
  }
}
export class CampaignAccessDeniedError extends CampaignGameError {
  constructor() {
    super('CAMPAIGN_NOT_FOUND', 404, 'Campaign was not found');
    this.name = 'CampaignAccessDeniedError';
  }
}
export class CountryNotAssignedError extends CampaignGameError {
  constructor() {
    super('COUNTRY_NOT_ASSIGNED', 409, 'Register a country before issuing orders');
    this.name = 'CountryNotAssignedError';
  }
}
export class CountryNotActiveError extends CampaignGameError {
  constructor() {
    super('COUNTRY_NOT_ACTIVE', 409, 'The campaign country is not active');
    this.name = 'CountryNotActiveError';
  }
}
export class CampaignOrderNotFoundError extends CampaignGameError {
  constructor() {
    super('ORDER_NOT_FOUND', 404, 'Order was not found');
    this.name = 'CampaignOrderNotFoundError';
  }
}
export class CampaignOrderStateError extends CampaignGameError {
  constructor() {
    super('ORDER_NOT_EDITABLE', 409, 'The order or campaign is no longer editable');
    this.name = 'CampaignOrderStateError';
  }
}
export class LastActiveMemberError extends CampaignGameError {
  constructor() {
    super('LAST_ACTIVE_MEMBER', 409, 'The last active campaign member cannot leave');
    this.name = 'LastActiveMemberError';
  }
}
export class WorldSnapshotUnavailableError extends CampaignGameError {
  constructor() {
    super('WORLD_SNAPSHOT_UNAVAILABLE', 409, 'The current world snapshot is not available');
    this.name = 'WorldSnapshotUnavailableError';
  }
}

export class CampaignInvitationNotFoundError extends CampaignGameError {
  constructor() {
    super('INVITATION_NOT_FOUND', 404, 'Campaign invitation was not found');
    this.name = 'CampaignInvitationNotFoundError';
  }
}
export class CampaignInvitationConflictError extends CampaignGameError {
  constructor(message = 'The invitation is no longer available or the user is already a member') {
    super('INVITATION_CONFLICT', 409, message);
    this.name = 'CampaignInvitationConflictError';
  }
}
export class CampaignInvitationEmailMismatchError extends CampaignGameError {
  constructor() {
    super('INVITATION_EMAIL_MISMATCH', 403, 'The invitation belongs to a different email address');
    this.name = 'CampaignInvitationEmailMismatchError';
  }
}
export class CampaignInvitationForbiddenError extends CampaignGameError {
  constructor() {
    super('INVITATION_FORBIDDEN', 403, 'Only the member who created this invitation can revoke it');
    this.name = 'CampaignInvitationForbiddenError';
  }
}