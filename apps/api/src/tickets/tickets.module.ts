import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { DepartmentsModule } from '../departments/departments.module';
import { FieldsModule } from '../fields/fields.module';
import { OutboundModule } from '../outbound/outbound.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [FieldsModule, DepartmentsModule, CustomersModule, OutboundModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
