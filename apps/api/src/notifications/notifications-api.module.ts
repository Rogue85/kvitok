import { Module } from '@nestjs/common';
import { NotificationSettingsController } from './notification-settings.controller';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { VapidKeysService } from './vapid-keys.service';
import { WebPushSender } from './web-push.sender';

/** Notification settings and push subscriptions of the signed-in user. */
@Module({
  controllers: [NotificationSettingsController, PushSubscriptionsController],
  providers: [VapidKeysService, WebPushSender],
})
export class NotificationsApiModule {}
