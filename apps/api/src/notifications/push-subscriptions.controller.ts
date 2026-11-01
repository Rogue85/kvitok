import { t } from '@kvitok/i18n';
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PushSubscriptionInputSchema, type PushConfigDto, type PushSubscriptionDto, type PushSubscriptionInput } from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { PushSubscription } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VapidKeysService } from './vapid-keys.service';
import { WebPushSender } from './web-push.sender';

/**
 * The user's browsers subscribed to web push. A subscription belongs to the session it was made in,
 * so subscribing needs a sign-in session, and signing out on the device ends it.
 */
@Controller('notifications/push')
export class PushSubscriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vapid: VapidKeysService,
    private readonly sender: WebPushSender,
  ) {}

  @Get()
  async config(@CurrentAuth() auth: AuthContext): Promise<PushConfigDto> {
    const [keys, rows] = await Promise.all([
      this.vapid.get(),
      this.prisma.pushSubscription.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { publicKey: keys.publicKey, subscriptions: rows.map((row) => toDto(row, auth)) };
  }

  /** The same browser subscribing again (or after another user signed in on it) takes the subscription over. */
  @Post('subscriptions')
  async subscribe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(PushSubscriptionInputSchema)) body: PushSubscriptionInput,
  ): Promise<PushSubscriptionDto> {
    const sessionId = this.sessionOf(auth);
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { userAgent: true } });
    const data = { userId: auth.user.id, sessionId, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: session?.userAgent ?? null, lastError: null };
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: { id: newId(), endpoint: body.endpoint, ...data },
      update: data,
    });
    return toDto(row, auth);
  }

  @Delete('subscriptions/:subscriptionId')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Param('subscriptionId') id: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { id, userId: auth.user.id } });
  }

  /** Sends a test notification right away and reports what the push service answered. */
  @Post('subscriptions/:subscriptionId/test')
  async test(@CurrentAuth() auth: AuthContext, @Param('subscriptionId') id: string): Promise<PushSubscriptionDto> {
    this.sessionOf(auth);
    const subscription = await this.prisma.pushSubscription.findFirst({ where: { id, userId: auth.user.id } });
    if (subscription === null) throw errors.notFound(t('api.pushSubscriptionNotFound'));
    const error = await this.sender.send(subscription, {
      title: t('notifications.push.testTitle'),
      body: t('notifications.push.testBody'),
      url: '/notifications',
      tag: 'test',
    });
    const row = await this.prisma.pushSubscription.findUnique({ where: { id } });
    if (row === null) throw errors.validation([], t('api.pushSubscriptionGone', { error: error ?? '' }));
    return toDto(row, auth);
  }

  private sessionOf(auth: AuthContext): string {
    if (auth.sessionId === null) throw errors.forbidden(t('api.tokenRouteClosed'));
    return auth.sessionId;
  }
}

function toDto(row: PushSubscription, auth: AuthContext): PushSubscriptionDto {
  return {
    id: row.id,
    userAgent: row.userAgent,
    current: row.sessionId === auth.sessionId,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}
