import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AuthValidationError,
  ChatServiceError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
  UnauthenticatedError,
  type AuthService,
  type CampaignService,
  type ChatService,
} from '@paper-wars/auth';
import { createSimulationEngine } from '@paper-wars/simulation';
import { CHAT_PAGE_HTML } from './chat-page.js';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
  readonly authService?: AuthService;
  readonly campaignService?: CampaignService;
  readonly chatService?: ChatService;
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
      const message = await chatService.sendCampaignMessage(\n        user.id,\n        campaignId,\n        body['message'],\n      );
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

  app.get('/chat', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type('text/html; charset=utf-8').send(CHAT_PAGE_HTML);
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

  if (options.authService !== undefined && options.chatService !== undefined) {
    registerChatRoutes(app, options.authService, options.chatService);
  }

  return app;
}
