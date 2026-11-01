import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AcceptPasswordLinkSchema, type AcceptPasswordLinkInput, type MeResponse, type PasswordLinkInfoDto } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env';
import type { AppRequest } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PasswordLinksService } from '../users/password-links.service';
import { AuthService } from './auth.service';
import { Public } from './decorators';
import { setSessionCookie } from './session-cookie';

/** Invitations and password resets: the person opens the link, sets a password and is signed in. */
@Controller('password-links')
@Public()
@UseGuards(ThrottlerGuard)
export class PasswordLinksController {
  constructor(
    private readonly links: PasswordLinksService,
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get(':token')
  info(@Param('token') token: string): Promise<PasswordLinkInfoDto> {
    return this.links.info(token);
  }

  @Post(':token')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(AcceptPasswordLinkSchema)) body: AcceptPasswordLinkInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    const user = await this.links.accept(token, body.password);
    const session = await this.authService.startSession(user, { ip: request.ip, userAgent: request.headers['user-agent'] });
    setSessionCookie(reply, this.config, session);
    return this.authService.me(user.id);
  }
}
