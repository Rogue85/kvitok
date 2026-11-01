import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config/env';
import type { LoginResult } from './auth.service';
import { SESSION_COOKIE } from './session-token';

export function setSessionCookie(reply: FastifyReply, config: AppConfig, session: LoginResult): void {
  reply.setCookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    // trustProxy: behind a TLS-terminating proxy the protocol comes from X-Forwarded-Proto.
    secure: config.cookieSecure === 'auto' ? reply.request.protocol === 'https' : config.cookieSecure,
    path: '/',
    expires: session.expiresAt,
  });
}
