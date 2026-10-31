import { t } from '@kvitok/i18n';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { errors } from '../common/errors';
import type { Channel } from '../generated/prisma/client';
import type { AppRequest } from '../common/request';

export type IngestRequest = AppRequest & { channel?: Channel };

/** The API channel key in `Authorization: Bearer <key>`; the channel from the `:channelId` path. */
@Injectable()
export class IngestAuthGuard implements CanActivate {
  constructor(private readonly channels: ChannelsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IngestRequest>();
    const channelId = (request.params as Record<string, string | undefined>).channelId;
    const header = request.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    const channel = channelId && key ? await this.channels.authenticateApiKey(channelId, key) : null;
    if (channel === null) {
      throw errors.unauthorized(t('api.invalidChannelKey'));
    }
    if (!channel.enabled) {
      throw errors.forbidden(t('api.channelDisabled'));
    }

    request.channel = channel;
    return true;
  }
}
