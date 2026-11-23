import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AuthValidationError,
  ChatServiceError,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  ExternalIdentityAlreadyLinkedError,
  ExternalIdentityEmailConflictError,
  ExternalIdentityEmailRequiredError,
  InvalidEmailVerificationTokenError,
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
import { GAME_PAGE_HTML } from './game-page.js';
import type { VerificationEmailSender } from './email.js';
import { VERIFY_EMAIL_PAGE_HTML } from './verify-email-page.js';
import { completeVkAuthorization, createVkAuthorizationStart, type VkIdOptions } from './vk-id.js';

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly rulesetVersion?: string;
  readonly rngVersion?: string;
  readonly authService?: AuthService;
  readonly campaignService?: CampaignService;
  readonly chatService?: ChatService;
  readonly verificationEmailSender?: VerificationEmailSender;
  readonly appBaseUrl?: string;
  readonly vkId?: VkIdOptions;
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
  if (
    error instanceof EmailAlreadyRegisteredError ||
    error instanceof ExternalIdentityEmailConflictError
  ) {
    return reply.code(409).send({ error: 'EMAIL_ALREADY_REGISTERED', message: error.message });
  }
  if (error instanceof EmailNotVerifiedError) {
    return reply.code(403).send({
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Подтвердите email по ссылке из письма.',
    });
  }
  if (error instanceof InvalidEmailVerificationTokenError) {
    return reply.code(400).send({
      error: 'INVALID_VERIFICATION_TOKEN',
      message: error.message,
    });
  }
  if (
    error instanceof ExternalIdentityEmailRequiredError ||
    error instanceof ExternalIdentityAlreadyLinkedError
  ) {
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
  return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
}

function createVerificationUrl(baseUrl: string, token: string): string {
  const url = new URL('/verify-email', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function deliverVerificationEmail(
  sender: VerificationEmailSender | undefined,
  baseUrl: string,
  email: string,
  token: string,
): Promise<void> {
  if (sender === undefined) throw new Error('Email verification delivery is not configured');
  await sender.sendVerificationEmail(email, createVerificationUrl(baseUrl, token));
}

function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookies: boolean,
  verificationEmailSender: VerificationEmailSender | undefined,
  appBaseUrl: string,
): void {
  app.post('/auth/register', async (request, reply) => {
    try {
      if (verificationEmailSender === undefined) {
        return reply.code(503).send({ error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
      }
      const body = asRecord(request.body);
      const challenge = await authService.register(body['email'], body['password']);
      try {
        await deliverVerificationEmail(
          verificationEmailSender,
          appBaseUrl,
          challenge.user.email,
          challenge.verificationToken,
        );
      } catch {
        return reply.code(503).send({
          error: 'VERIFICATION_EMAIL_FAILED',
          message: 'Не удалось отправить письмо. Попробуйте запросить его повторно.',
        });
      }
      return reply.code(202).send({
        verificationRequired: true,
        message: 'Письмо с подтверждением отправлено на указанный адрес.',
      });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/resend-verification', async (request, reply) => {
    try {
      if (verificationEmailSender === undefined) {
        return reply.code(503).send({ error: 'EMAIL_DELIVERY_NOT_CONFIGURED' });
      }
      const body = asRecord(request.body);
      const challenge = await authService.resendEmailVerification(body['email']);
      if (challenge !== undefined) {
        try {
          await deliverVerificationEmail(
            verificationEmailSender,
            appBaseUrl,
            challenge.user.email,
            challenge.verificationToken,
          );
        } catch {
          return reply.code(503).send({ error: 'VERIFICATION_EMAIL_FAILED' });
        }
      }
      return reply.code(202).send({
        message:
          'Если аккаунт ожидает подтверждения, письмо будет отправлено. Подождите не менее минуты перед повторным запросом.',
      });
    } catch (error) {
      return sendAuthError(error, reply);
    }
  });

  app.post('/auth/verify-email', async (request, reply) => {
    try {
      const body = asRecord(request.body);
      if (typeof body['token'] !== 'string') {
        throw new AuthValidationError('Verification token is required');
      }
      const session = await authService.verifyEmail(body['token']);
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

function registerVkRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookies: boolean,
  verificationEmailSender: VerificationEmailSender | undefined,
  appBaseUrl: string,
  vkId: VkIdOptions | undefined,
): void {
  app.get('/auth/vk/start', async (_request, reply) => {
    if (vkId === undefined) return reply.redirect('/verify-email?error=vk-unavailable');
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
    if (vkId === undefined) return reply.redirect('/verify-email?error=vk-unavailable');
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
        return reply.redirect('/chat?vk=linked');
      }
      const authResult = await authService.signInWithVk(result.providerUserId, result.email);
      if (authResult.kind === 'session') {
        setRefreshCookie(reply, authResult.session, secureCookies);
        return reply.redirect('/chat');
      }
      if (authResult.challenge !== undefined) {
        await deliverVerificationEmail(
          verificationEmailSender,
          appBaseUrl,
          authResult.challenge.user.email,
          authResult.challenge.verificationToken,
        );
      }
      return reply.redirect('/verify-email?sent=1');
    } catch (error) {
      if (error instanceof ExternalIdentityEmailConflictError) {
        return reply.redirect('/verify-email?error=vk-email-exists');
      }
      if (error instanceof ExternalIdentityEmailRequiredError) {
        return reply.redirect('/verify-email?error=vk-no-email');
      }
      request.log.warn({ err: error }, 'VK ID authentication failed');
      return reply.redirect('/chat?authError=vk-failed');
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
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    return reply.type('text/html; charset=utf-8').send(GAME_PAGE_HTML);
  });

  app.get('/chat', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(CHAT_PAGE_HTML);
  });

  app.get('/verify-email', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(VERIFY_EMAIL_PAGE_HTML);
  });

  app.get('/health', async () => ({
    status: 'ok',
    engineVersion: engine.engineVersion,
    rulesetVersion: engine.rulesetVersion,
    rngVersion: engine.rngVersion,
  }));

  if (options.authService !== undefined) {
    const appBaseUrl = options.appBaseUrl ?? 'http://127.0.0.1:3000';
    registerAuthRoutes(
      app,
      options.authService,
      options.secureCookies ?? false,
      options.verificationEmailSender,
      appBaseUrl,
    );
    registerVkRoutes(
      app,
      options.authService,
      options.secureCookies ?? false,
      options.verificationEmailSender,
      appBaseUrl,
      options.vkId,
    );
  }

  if (options.authService !== undefined && options.campaignService !== undefined) {
    registerCampaignRoutes(app, options.authService, options.campaignService);
  }

  if (options.authService !== undefined && options.chatService !== undefined) {
    registerChatRoutes(app, options.authService, options.chatService);
  }

  return app;
}
