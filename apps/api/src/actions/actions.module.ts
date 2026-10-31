import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ACTIONS_QUEUE } from './actions.constants';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';

@Module({
  imports: [BullModule.registerQueue({ name: ACTIONS_QUEUE })],
  controllers: [ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
