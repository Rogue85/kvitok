import { Module } from '@nestjs/common';
import { MailQueueModule } from '../mail/mail-queue.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [MailQueueModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
