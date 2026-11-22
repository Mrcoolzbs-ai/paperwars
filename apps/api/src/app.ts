import { readFile } from 'node:fs/promises';
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
  SocialSystemAdminRequiredError,
  SocialSystemLimitReachedError,
  SocialSystemNameConflictError,
  SocialSystemNotFoundError,
  SocialSystemReviewConflictError,
  SpawnAreaUnavailableError,
  SystemAvailabilityNotConfiguredError,
  type CountrySetupService,
  type CreateCountryInput,
  type CreateSocialSystemInput,
  type OfficialSystemType,
  type SocialSystemReviewInput,
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
  if (
    error instanceof NotActiveCampaignMemberError ||
    error instanceof SocialSystemAdminRequiredError
  ) {
    return reply.code(403).send({
      error:
        error instanceof SocialSystemAdminRequiredError
          ? 'SOCIAL_SYSTEM_ADMIN_REQUIRED'
          : 'NOT_ACTIVE_CAMPAIGN_MEMBER',
    });
  }
  if (error instanceof SocialSystemNotFoundError) {
    return reply.code(404).send({ error: 'SOCIAL_SYSTEM_NOT_FOUND' });
  }
  if (
    error instanceof CampaignSetupNotReadyError ||
    error instanceof CountryAlreadyRegisteredError ||
    error instanceof SpawnAreaUnavailableError ||
    error instanceof SocialSystemLimitReachedError ||
    error instanceof SocialSystemNameConflictError ||
    error instanceof SocialSystemReviewConflictError
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
      const turnDurationHours = body['turnDurationHours'];
      const mapSeed = body['mapSeed'];
      const campaign = await campaignService.createCampaign(user.id, body['name'], {
        mapWidth: body['mapWidth'] as number,
        mapHeight: body['mapHeight'] as number,
        ...(typeof turnDurationHours === 'number' ? { turnDurationHours } : {}),
        ...(typeof mapSeed === 'string' ? { mapSeed } : {}),
      });
      return reply.code(201).send({ campaign });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/campaigns/:campaignId/join', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      await campaignService.joinCampaign(user.id, getCampaignId(request));
      return reply.code(204).send();
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.delete('/campaigns/:campaignId/leave', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      await campaignService.leaveCampaign(user.id, getCampaignId(request));
      return reply.code(204).send();
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
  app.get('/social-systems/mine', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const systems = await countrySetupService.listMySocialSystemLibrary(user.id);
      return reply.send({ systems });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/countries/mine', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const country = await countrySetupService.getMyCountry(user.id, getCampaignId(request));
      return reply.send({ country });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/map', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const map = await countrySetupService.getCampaignMap(user.id, getCampaignId(request));
      return reply.send({ map });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.put('/campaigns/:campaignId/spawn-reservation', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const reservation = await countrySetupService.reserveSpawn(
        user.id,
        getCampaignId(request),
        parseCoordinate(body['centerX'], 'centerX'),
        parseCoordinate(body['centerY'], 'centerY'),
      );
      return reply.send({ reservation });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/campaigns/:campaignId/social-systems', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const system = await countrySetupService.createSocialSystem(
        user.id,
        getCampaignId(request),
        body as unknown as CreateSocialSystemInput,
      );
      return reply.code(201).send({ system });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/social-systems/mine', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const systems = await countrySetupService.listMySocialSystems(
        user.id,
        getCampaignId(request),
      );
      return reply.send({ systems });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/social-systems/pending', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const systems = await countrySetupService.listPendingSocialSystems(
        user.id,
        getCampaignId(request),
      );
      return reply.send({ systems });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post<{ Params: { campaignId: string; systemId: string } }>(
    '/campaigns/:campaignId/social-systems/:systemId/review',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const body = asRecord(request.body);
        const system = await countrySetupService.reviewSocialSystem(
          user.id,
          request.params.campaignId,
          request.params.systemId,
          body as unknown as SocialSystemReviewInput,
        );
        return reply.send({ system });
      } catch (error) {
        return sendAuthError(error, reply);
      }
    },
  );

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

  app.get('/', async (_request, reply) => {
    const page = await readFile(new URL('../../web/public/index.html', import.meta.url));
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page);
  });

  app.get('/styles.css', async (_request, reply) => {
    const stylesheet = await readFile(new URL('../../web/public/styles.css', import.meta.url));
    return reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(stylesheet);
  });

  app.get('/app.js', async (_request, reply) => {
    const script = await readFile(new URL('../../web/public/app.js', import.meta.url));
    return reply
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(script);
  });

  app.get('/assets/buildings/:file', async (request, reply) => {
    const params = request.params as { readonly file?: unknown };
    const allowed = new Set([
      'factory.jpg',
      'field.jpg',
      'tower.jpg',
      'barracks.jpg',
      'capital.jpg',
      'science.jpg',
      'gold-mark.jpg',
    ]);
    if (typeof params.file !== 'string' || !allowed.has(params.file)) {
      return reply.code(404).send({ error: 'BUILDING_ASSET_NOT_FOUND' });
    }
    const asset = await readFile(
      new URL('../../web/public/assets/buildings/' + params.file, import.meta.url),
    );
    return reply.type('image/jpeg').header('Cache-Control', 'public, max-age=86400').send(asset);
  });

  app.get('/favicon.svg', async (_request, reply) => {
    const icon = await readFile(new URL('../../web/public/favicon.svg', import.meta.url));
    return reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=86400').send(icon);
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
