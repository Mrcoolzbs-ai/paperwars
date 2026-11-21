import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AuthValidationError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
  UnauthenticatedError,
  type AuthService,
  type CampaignService,
} from '@paper-wars/auth';
import { createSimulationEngine } from '@paper-wars/simulation';
import {
  CampaignSetupNotReadyError,
  CountryAlreadyRegisteredError,
  CountrySetupValidationError,
  NotActiveCampaignMemberError,
  OfficialSystemNotAvailableError,
  SpawnAreaUnavailableError,
  SystemAvailabilityNotConfiguredError,
  type CountrySetupService,
  type CreateCountryInput,
  type OfficialSystemType,
} from '@paper-wars/world';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
  readonly authService?: AuthService;
  readonly campaignService?: CampaignService;
  readonly countrySetupService?: CountrySetupService;
  readonly secureCookies?: boolean;
}

interface RecordBody {
  readonly [key: string]: unknown;
}

interface AuthRouteSession {
  readonly user: { readonly id: string; readonly email: string };
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

function asRecord(value: unknown): RecordBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthValidationError('Request body must be a JSON object');
  }
  return value as RecordBody;
}

function getRefreshCookie(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return undefined;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== 'refresh_token') continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    throw new UnauthenticatedError();
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (match?.[1] === undefined) {
    throw new UnauthenticatedError();
  }
  return match[1];
}

function setRefreshCookie(reply: FastifyReply, session: AuthRouteSession, secure: boolean): void {
  const maxAge = Math.max(
    0,
    Math.floor((session.refreshTokenExpiresAt.getTime() - Date.now()) / 1000),
  );
  const secureAttribute = secure ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `refresh_token=${encodeURIComponent(session.refreshToken)}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureAttribute}`,
  );
}

function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  const secureAttribute = secure ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `refresh_token=; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=0${secureAttribute}`,
  );
}

function sendAuthError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof AuthValidationError) {
    return reply.code(400).send({ error: 'INVALID_REQUEST', message: error.message });
  }
  if (error instanceof EmailAlreadyRegisteredError) {
    return reply.code(409).send({ error: 'EMAIL_ALREADY_REGISTERED' });
  }
  if (
    error instanceof RefreshTokenReuseDetectedError ||
    error instanceof InvalidRefreshTokenError ||
    error instanceof InvalidCredentialsError ||
    error instanceof UnauthenticatedError
  ) {
    return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  }
  if (error instanceof CountrySetupValidationError) {
    return reply.code(400).send({ error: 'INVALID_COUNTRY_SETUP', message: error.message });
  }
  if (error instanceof NotActiveCampaignMemberError) {
    return reply.code(403).send({ error: 'NOT_ACTIVE_CAMPAIGN_MEMBER' });
  }
  if (
    error instanceof CampaignSetupNotReadyError ||
    error instanceof CountryAlreadyRegisteredError ||
    error instanceof SpawnAreaUnavailableError
  ) {
    return reply.code(409).send({ error: 'COUNTRY_SETUP_CONFLICT', message: error.message });
  }
  if (error instanceof OfficialSystemNotAvailableError) {
    return reply.code(422).send({ error: 'OFFICIAL_SYSTEM_NOT_AVAILABLE' });
  }
  if (error instanceof SystemAvailabilityNotConfiguredError) {
    return reply.code(503).send({ error: 'SYSTEM_AVAILABILITY_NOT_CONFIGURED' });
  }
  return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
}

function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookies: boolean,
): void {
  app.post('/auth/register', async (request, reply) => {
    try {
      const body = asRecord(request.body);
      const session = await authService.register(body['email'], body['password']);
      setRefreshCookie(reply, session, secureCookies);
      return reply.code(201).send({
        user: session.user,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
      });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/login', async (request, reply) => {
    try {
      const body = asRecord(request.body);
      const session = await authService.login(body['email'], body['password']);
      setRefreshCookie(reply, session, secureCookies);
      return reply.send({
        user: session.user,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
      });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/refresh', async (request, reply) => {
    try {
      const refreshToken = getRefreshCookie(request);
      if (refreshToken === undefined) {
        throw new InvalidRefreshTokenError();
      }
      const session = await authService.refresh(refreshToken);
      setRefreshCookie(reply, session, secureCookies);
      return reply.send({
        user: session.user,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
      });
    } catch (error) {
      clearRefreshCookie(reply, secureCookies);
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    try {
      const refreshToken = getRefreshCookie(request);
      if (refreshToken !== undefined) {
        await authService.logout(refreshToken);
      }
      clearRefreshCookie(reply, secureCookies);
      return reply.code(204).send();
    } catch (error) {
      clearRefreshCookie(reply, secureCookies);
      return sendAuthError(error, reply);
    }
  });

  app.get('/auth/me', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      return reply.send({ user });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });
}

function registerCampaignRoutes(
  app: FastifyInstance,
  authService: AuthService,
  campaignService: CampaignService,
): void {
  app.post('/campaigns', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const campaign = await campaignService.createCampaign(user.id, body['name'], {
        mapWidth: body['mapWidth'] as number,
        mapHeight: body['mapHeight'] as number,
      });
      return reply.code(201).send({ campaign });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const campaigns = await campaignService.listCampaignsForUser(user.id);
      return reply.send({ campaigns });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });
}

function parseCoordinate(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new CountrySetupValidationError(`${field} must be a safe integer`);
}

function getCampaignId(request: FastifyRequest): string {
  const params = asRecord(request.params);
  const campaignId = params['campaignId'];
  if (typeof campaignId !== 'string' || campaignId.trim().length === 0) {
    throw new CountrySetupValidationError('campaignId is required');
  }
  return campaignId;
}

function registerCountryRoutes(
  app: FastifyInstance,
  authService: AuthService,
  countrySetupService: CountrySetupService,
): void {
  app.post('/campaigns/:campaignId/countries', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const country = await countrySetupService.createCountry(
        user.id,
        getCampaignId(request),
        body as unknown as CreateCountryInput,
      );
      return reply.code(201).send({ country });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/social-systems/available', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const query = asRecord(request.query);
      const systemType = query['systemType'];
      if (systemType !== 'religion' && systemType !== 'ideology') {
        throw new CountrySetupValidationError('systemType must be religion or ideology');
      }
      const systems = await countrySetupService.listAvailableSystems(
        user.id,
        getCampaignId(request),
        systemType as OfficialSystemType,
        parseCoordinate(query['spawnX'], 'spawnX'),
        parseCoordinate(query['spawnY'], 'spawnY'),
      );
      return reply.send({ systems });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });
}

/** Creates an API instance without opening a socket or starting background work. */
export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const engine = createSimulationEngine({
    rulesetVersion: options.rulesetVersion ?? 'baseline-v1',
    rngVersion: options.rngVersion ?? 'rng-v1',
  });

  app.get('/health', async () => ({
    status: 'ok',
    engineVersion: engine.engineVersion,
    rulesetVersion: engine.rulesetVersion,
    rngVersion: engine.rngVersion,
  }));

  if (options.authService !== undefined) {
    registerAuthRoutes(app, options.authService, options.secureCookies ?? false);
  }

  if (options.authService !== undefined && options.campaignService !== undefined) {
    registerCampaignRoutes(app, options.authService, options.campaignService);
  }

  if (options.authService !== undefined && options.countrySetupService !== undefined) {
    registerCountryRoutes(app, options.authService, options.countrySetupService);
  }

  return app;
}
