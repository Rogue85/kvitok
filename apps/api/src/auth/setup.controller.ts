import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SetupSchema, type MeResponse, type SetupInput, type SetupStatusDto } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env';
import type { AppRequest } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators';
import { setSessionCookie } from './session-cookie';
import { SetupService } from './setup.service';

@Controller('setup')
@Public()
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async status(): Promise<SetupStatusDto> {
    return { required: await this.setup.required() };
  }

  /** Creates the first superadmin and workspace and signs the superadmin in. */
  @Post()
  @UseGuards(ThrottlerGuard)
  async run(
    @Body(new ZodValidationPipe(SetupSchema)) body: SetupInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    const user = await this.setup.run(body);
    const session = await this.authService.startSession(user, { ip: request.ip, userAgent: request.headers['user-agent'] });
    setSessionCookie(reply, this.config, session);
    return this.authService.me(user.id);
  }
}
