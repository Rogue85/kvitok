import { Module } from '@nestjs/common';
import { FieldsModule } from '../fields/fields.module';
import { RuleApplier } from './rule-applier';
import { RoutingController } from './routing.controller';
import { RoutingRulesService } from './routing-rules.service';

@Module({
  imports: [FieldsModule],
  controllers: [RoutingController],
  providers: [RoutingRulesService, RuleApplier],
  exports: [RoutingRulesService, RuleApplier],
})
export class RoutingModule {}
