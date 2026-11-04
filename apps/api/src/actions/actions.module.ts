import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ACTIONS_QUEUE } from './actions.constants';
import { ActionsController, TicketActionsController } from './actions.controller';
import { ActionsService } from './actions.service';

@Module({
  imports: [BullModule.registerQueue({ name: ACTIONS_QUEUE }), IntegrationsModule],
  controllers: [TicketActionsController, ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
