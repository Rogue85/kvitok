import { t } from '@kvitok/i18n';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { LoginSchema, type LoginInput, type MeResponse } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { errors } from '../common/errors';
import type { AppRequest, AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CurrentAuth, Public } from './decorators';
import { SESSION_COOKIE } from './session-token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    const result = await this.authService.login(body.email, body.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    if (result === null) {
      throw errors.unauthorized(t('api.invalidCredentials'));
    }

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      path: '/',
      expires: result.expiresAt,
    });

    return this.authService.me(result.auth.user.id);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.authService.logout(auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.authService.me(auth.user.id);
  }
}
