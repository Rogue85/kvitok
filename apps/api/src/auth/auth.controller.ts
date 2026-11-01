import { t } from '@kvitok/i18n';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  ChangePasswordSchema,
  LoginSchema,
  UpdateProfileSchema,
  type ChangePasswordInput,
  type LoginInput,
  type MeResponse,
  type SessionDto,
  type UpdateProfileInput,
} from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { errors } from '../common/errors';
import type { AppRequest, AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CurrentAuth, Public } from './decorators';
import { setSessionCookie } from './session-cookie';
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

    setSessionCookie(reply, this.config, result);
    return this.authService.me(result.auth.user.id);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    if (auth.sessionId !== null) await this.authService.logout(auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  async me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    const me = await this.authService.me(auth.user.id);
    // A token restricted to one workspace does not reveal the others.
    const tokenWorkspaceId = auth.token?.workspaceId ?? null;
    return tokenWorkspaceId === null ? me : { ...me, workspaces: me.workspaces.filter((w) => w.workspaceId === tokenWorkspaceId) };
  }

  @Patch('me')
  async updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ): Promise<MeResponse> {
    await this.authService.updateProfile(auth.user.id, body.name);
    return this.authService.me(auth.user.id);
  }

  @UseGuards(ThrottlerGuard)
  @Post('password')
  @HttpCode(204)
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    return this.authService.changePassword(auth, body.currentPassword, body.newPassword);
  }

  @Get('sessions')
  sessions(@CurrentAuth() auth: AuthContext): Promise<SessionDto[]> {
    return this.authService.sessions(auth);
  }

  /** Signs out everywhere except here. */
  @Delete('sessions')
  @HttpCode(204)
  endOtherSessions(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.authService.endOtherSessions(auth);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  endSession(@CurrentAuth() auth: AuthContext, @Param('sessionId') sessionId: string): Promise<void> {
    return this.authService.endSession(auth, sessionId);
  }
}
