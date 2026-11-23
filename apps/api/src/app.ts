import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AuthValidationError,
  ChatServiceError,
  DisplayNameAlreadyTakenError,
  EmailAlreadyRegisteredError,
  ExternalIdentityAlreadyLinkedError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
  UnauthenticatedError,
  type AuthService,
  type CampaignService,
  type ChatService,
} from '@paper-wars/auth';
import { createSimulationEngine } from '@paper-wars/simulation';
import { CampaignTurnProcessingError } from '@paper-wars/persistence';
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
import { CHAT_PAGE_HTML } from './chat-page.js';
import { completeVkAuthorization, createVkAuthorizationStart, type VkIdOptions } from './vk-id.js';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
  readonly authService?: AuthService;
  readonly campaignService?: CampaignService;
  readonly countrySetupService?: CountrySetupService;
  readonly chatService?: ChatService;
  readonly vkId?: VkIdOptions;
  readonly secureCookies?: boolean;
  /** Optional built HTML entry point used by the production server. */
  readonly webEntryPath?: string;
}

interface RecordBody {
  readonly [key: string]: unknown;
}

interface AuthRouteSession {
  readonly user: {
    readonly id: string;
    readonly email: string | null;
    readonly displayName: string;
  };
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

function getCookie(request: FastifyRequest, cookieName: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getRefreshCookie(request: FastifyRequest): string | undefined {
  return getCookie(request, 'refresh_token');
}

function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') throw new UnauthenticatedError();
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (match?.[1] === undefined) throw new UnauthenticatedError();
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
  if (error instanceof CampaignTurnProcessingError) {
    if (error.code === 'INVALID_ORDER') {
      return reply.code(400).send({ error: error.code, message: error.message });
    }
    if (error.code === 'CAMPAIGN_NOT_FOUND' || error.code === 'ORDER_NOT_FOUND') {
      return reply.code(404).send({ error: error.code, message: error.message });
    }
    if (error.code === 'NOT_ACTIVE_MEMBER') {
      return reply.code(403).send({ error: error.code, message: error.message });
    }
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof EmailAlreadyRegisteredError) {
    return reply.code(409).send({ error: 'EMAIL_ALREADY_REGISTERED', message: error.message });
  }
  if (error instanceof DisplayNameAlreadyTakenError) {
    return reply.code(409).send({ error: 'NICKNAME_ALREADY_TAKEN', message: error.message });
  }
  if (error instanceof ExternalIdentityAlreadyLinkedError) {
    return reply.code(409).send({ error: 'VK_IDENTITY_CONFLICT', message: error.message });
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
  reply.log.error({ err: error }, 'Unhandled API request error');
  return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
}

function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookies: boolean,
): void {
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
      if (refreshToken === undefined) throw new InvalidRefreshTokenError();
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
      if (refreshToken !== undefined) await authService.logout(refreshToken);
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

  app.get('/auth/profile', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const profile = await authService.getProfile(user.id);
      return reply.send({ profile });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.put('/auth/profile', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const profile = await authService.updateProfile(user.id, body['displayName'], body['email']);
      return reply.send({ profile });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/password', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      await authService.updatePassword(user.id, body['currentPassword'], body['newPassword']);
      return reply.code(204).send();
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });
}

function registerVkRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookies: boolean,
  vkId: VkIdOptions | undefined,
): void {
  app.get('/auth/vk/start', async (_request, reply) => {
    if (vkId === undefined) return reply.redirect('/?authError=vk-unavailable');
    const start = createVkAuthorizationStart(vkId, secureCookies);
    reply.header('Set-Cookie', start.stateCookie);
    return reply.redirect(start.authorizationUrl);
  });

  app.post('/auth/vk/link', async (request, reply) => {
    try {
      if (vkId === undefined) return reply.code(503).send({ error: 'VK_ID_NOT_CONFIGURED' });
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const start = createVkAuthorizationStart(vkId, secureCookies, user.id);
      reply.header('Set-Cookie', start.stateCookie);
      return reply.send({ authorizationUrl: start.authorizationUrl });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/auth/vk/callback', async (request, reply) => {
    if (vkId === undefined) return reply.redirect('/?authError=vk-unavailable');
    try {
      const query = request.query as RecordBody;
      const code = query['code'];
      const state = query['state'];
      const deviceId = query['device_id'];
      if (typeof code !== 'string' || typeof state !== 'string' || typeof deviceId !== 'string') {
        throw new AuthValidationError('VK ID callback is incomplete');
      }
      const result = await completeVkAuthorization(vkId, {
        code,
        state,
        deviceId,
        stateCookie: getCookie(request, 'vk_oauth_state'),
      });
      if (result.linkUserId !== undefined) {
        await authService.linkVkIdentity(result.linkUserId, result.providerUserId);
        return reply.redirect('/?vk=linked');
      }
      const session = await authService.signInWithVk(result.providerUserId);
      setRefreshCookie(reply, session, secureCookies);
      return reply.redirect('/');
    } catch (error) {
      request.log.warn({ err: error }, 'VK ID authentication failed');
      return reply.redirect('/?authError=vk-failed');
    } finally {
      const currentCookies = reply.getHeader('Set-Cookie');
      const existingCookies = Array.isArray(currentCookies)
        ? currentCookies
        : currentCookies === undefined
          ? []
          : [String(currentCookies)];
      reply.header('Set-Cookie', [
        ...existingCookies,
        `vk_oauth_state=; Path=/auth/vk/callback; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`,
      ]);
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

  app.get('/campaigns/:campaignId/turn', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const turn = await campaignService.getTurnStatus(user.id, getCampaignId(request));
      return reply.send({ turn });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/events', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const events = await campaignService.listEvents(user.id, getCampaignId(request));
      return reply.send({ events });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/orders/mine', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const orders = await campaignService.listOrders(user.id, getCampaignId(request));
      return reply.send({ orders });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/orders/results', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const results = await campaignService.listOrderResults(user.id, getCampaignId(request));
      return reply.send({ results });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/campaigns/:campaignId/orders', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const order = await campaignService.createOrder(user.id, getCampaignId(request), {
        type: body['type'],
        schemaVersion: body['schemaVersion'],
        payload: body['payload'],
      });
      return reply.code(201).send({ order });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.patch<{ Params: { campaignId: string; orderId: string } }>(
    '/campaigns/:campaignId/orders/:orderId',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const body = asRecord(request.body);
        const order = await campaignService.updateOrder(
          user.id,
          getCampaignId(request),
          request.params.orderId,
          {
            ...(body['type'] === undefined ? {} : { type: body['type'] }),
            ...(body['schemaVersion'] === undefined
              ? {}
              : { schemaVersion: body['schemaVersion'] }),
            ...(body['payload'] === undefined ? {} : { payload: body['payload'] }),
          },
        );
        return reply.send({ order });
      } catch (error) {
        return sendAuthError(error, reply);
      }
    },
  );

  app.delete<{ Params: { campaignId: string; orderId: string } }>(
    '/campaigns/:campaignId/orders/:orderId',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        await campaignService.deleteOrder(user.id, getCampaignId(request), request.params.orderId);
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(error, reply);
      }
    },
  );

  app.post('/campaigns/:campaignId/orders/confirm', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const turnJob = await campaignService.confirmOrders(user.id, getCampaignId(request));
      return reply.send({
        confirmed: true,
        turnQueued: turnJob !== null,
        ...(turnJob === null ? {} : { turnJob }),
      });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.get('/campaigns/open', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const campaigns = await campaignService.listOpenCampaigns(user.id);
      return reply.send({ campaigns });
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

  app.post('/campaigns/:campaignId/countries/mine/buildings', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const building = await countrySetupService.buildBuilding(user.id, getCampaignId(request), {
        buildingType: body['buildingType'],
        x: parseCoordinate(body['x'], 'x'),
        y: parseCoordinate(body['y'], 'y'),
      });
      return reply.code(201).send({ building });
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

  app.get('/campaigns/:campaignId/discoveries', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const discoveries = await countrySetupService.listAccessibleDiscoveries(
        user.id,
        getCampaignId(request),
      );
      return reply.send({ discoveries });
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
function sendChatError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof ChatServiceError) {
    const status = error.code === 'NOT_ACTIVE_CAMPAIGN_MEMBER' ? 403 : 429;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  return sendAuthError(error, reply);
}

function registerChatRoutes(
  app: FastifyInstance,
  authService: AuthService,
  chatService: ChatService,
): void {
  app.get('/chat/world', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const messages = await chatService.listWorldMessages(user.id);
      return reply.send({ messages });
    } catch (error) {
      return sendChatError(error, reply);
    }
  });

  app.post('/chat/world', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const body = asRecord(request.body);
      const message = await chatService.sendWorldMessage(user.id, body['message']);
      return reply.code(201).send({ message });
    } catch (error) {
      return sendChatError(error, reply);
    }
  });

  app.get('/campaigns/:campaignId/chat', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const params = request.params as RecordBody;
      const campaignId = params['campaignId'];
      if (typeof campaignId !== 'string') {
        throw new AuthValidationError('Campaign ID is required');
      }
      const messages = await chatService.listCampaignMessages(user.id, campaignId);
      return reply.send({ messages });
    } catch (error) {
      return sendChatError(error, reply);
    }
  });

  app.post('/campaigns/:campaignId/chat', async (request, reply) => {
    try {
      const user = await authService.authenticateAccessToken(getBearerToken(request));
      const params = request.params as RecordBody;
      const campaignId = params['campaignId'];
      if (typeof campaignId !== 'string') {
        throw new AuthValidationError('Campaign ID is required');
      }
      const body = asRecord(request.body);
      const message = await chatService.sendCampaignMessage(user.id, campaignId, body['message']);
      return reply.code(201).send({ message });
    } catch (error) {
      return sendChatError(error, reply);
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
    try {
      const page = await readFile(
        options.webEntryPath ?? new URL('../../web/public/index.html', import.meta.url),
      );
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page);
    } catch (error) {
      if (options.webEntryPath === undefined) throw error;
      reply.log.error({ err: error }, 'Built browser client entry point could not be read');
      return reply.code(503).send({
        error: 'WEB_CLIENT_NOT_BUILT',
        message: 'The built browser client is missing. Run the Paper Wars launcher again.',
      });
    }
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

  app.get('/chat', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(CHAT_PAGE_HTML);
  });

  app.get('/health', async () => ({
    status: 'ok',
    apiContractVersion: 'browser-auth-v2',
    engineVersion: engine.engineVersion,
    rulesetVersion: engine.rulesetVersion,
    rngVersion: engine.rngVersion,
  }));

  if (options.authService !== undefined) {
    registerAuthRoutes(app, options.authService, options.secureCookies ?? false);
    registerVkRoutes(app, options.authService, options.secureCookies ?? false, options.vkId);
  }

  if (options.authService !== undefined && options.campaignService !== undefined) {
    registerCampaignRoutes(app, options.authService, options.campaignService);
  }

  if (options.authService !== undefined && options.countrySetupService !== undefined) {
    registerCountryRoutes(app, options.authService, options.countrySetupService);
  }

  if (options.authService !== undefined && options.chatService !== undefined) {
    registerChatRoutes(app, options.authService, options.chatService);
  }

  return app;
}
