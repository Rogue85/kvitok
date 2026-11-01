import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { DepartmentsModule } from '../departments/departments.module';
import { FieldsModule } from '../fields/fields.module';
import { OutboundModule } from '../outbound/outbound.module';
import { TicketViewsController } from './ticket-views.controller';
import { TicketViewsService } from './ticket-views.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [FieldsModule, DepartmentsModule, CustomersModule, OutboundModule],
  controllers: [TicketsController, TicketViewsController],
  providers: [TicketsService, TicketViewsService],
  exports: [TicketsService],
})
export class TicketsModule {}
