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
  CampaignGameError,
  type CampaignGameService,
  type CampaignWorldSnapshot,
  type CampaignMembershipView,
} from '@paper-wars/gameplay';
import { OrdersAlreadyLockedError, TurnProcessingError } from '@paper-wars/persistence';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
  readonly authService?: AuthService;
  readonly campaignService?: CampaignService;
  readonly secureCookies?: boolean;
  readonly campaignGameService?: CampaignGameService;
  readonly worldViewProjector?: WorldViewProjector;
}

export type WorldViewProjector = (input: {
  readonly snapshot: CampaignWorldSnapshot;
  readonly membership: CampaignMembershipView;
}) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;

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
      const campaign = await campaignService.createCampaign(user.id, body['name']);
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


function sendCampaignGameError(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof CampaignGameError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  if (error instanceof OrdersAlreadyLockedError) {
    return reply.code(409).send({ error: 'ORDERS_LOCKED' });
  }
  if (error instanceof TurnProcessingError) {
    return reply.code(409).send({ error: 'TURN_NOT_WRITABLE' });
  }
  return sendAuthError(error, reply);
}

function registerCampaignGameRoutes(
  app: FastifyInstance,
  authService: AuthService,
  gameService: CampaignGameService,
  worldViewProjector?: WorldViewProjector,
): void {
  app.get<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/membership',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const membership = await gameService.getMembership(user.id, request.params.campaignId);
        return reply.send({ membership });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/members',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const members = await gameService.listMembers(user.id, request.params.campaignId);
        return reply.send({ members });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/membership/leave',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const result = await gameService.leaveCampaign(user.id, request.params.campaignId);
        return reply.send({ membership: result });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/orders',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const orders = await gameService.listMyOrders(user.id, request.params.campaignId);
        return reply.send({ orders });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/orders',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const body = asRecord(request.body);
        const order = await gameService.createOrder(user.id, request.params.campaignId, {
          orderType: body['orderType'],
          schemaVersion: body['schemaVersion'],
          payload: body['payload'],
        });
        return reply.code(201).send({ order });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.patch<{ Params: { campaignId: string; orderId: string } }>(
    '/campaigns/:campaignId/orders/:orderId',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const body = asRecord(request.body);
        const order = await gameService.updateOrder(
          user.id,
          request.params.campaignId,
          request.params.orderId,
          {
            ...(body['orderType'] === undefined ? {} : { orderType: body['orderType'] }),
            ...(body['schemaVersion'] === undefined
              ? {}
              : { schemaVersion: body['schemaVersion'] }),
            ...(body['payload'] === undefined ? {} : { payload: body['payload'] }),
          },
        );
        return reply.send({ order });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.delete<{ Params: { campaignId: string; orderId: string } }>(
    '/campaigns/:campaignId/orders/:orderId',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        await gameService.deleteOrder(user.id, request.params.campaignId, request.params.orderId);
        return reply.code(204).send();
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/orders/confirm',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const result = await gameService.confirmOrders(user.id, request.params.campaignId);
        return reply.send(result);
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/turn',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const turn = await gameService.getTurnStatus(user.id, request.params.campaignId);
        return reply.send({ turn });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/turn/close',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const result = await gameService.closeTurn(user.id, request.params.campaignId);
        return reply.code(202).send({ job: result });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/world',
    async (request, reply) => {
      try {
        const user = await authService.authenticateAccessToken(getBearerToken(request));
        const input = await gameService.getCurrentWorldSnapshot(
          user.id,
          request.params.campaignId,
        );
        if (worldViewProjector === undefined) {
          return reply.code(503).send({ error: 'WORLD_VIEW_NOT_CONFIGURED' });
        }
        const world = await worldViewProjector(input);
        return reply.send({ world });
      } catch (error) {
        return sendCampaignGameError(error, reply);
      }
    },
  );
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

  if (options.authService !== undefined && options.campaignGameService !== undefined) {
    registerCampaignGameRoutes(
      app,
      options.authService,
      options.campaignGameService,
      options.worldViewProjector,
    );
  }

  return app;
}
