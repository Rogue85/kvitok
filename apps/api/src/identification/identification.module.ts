import { Module } from '@nestjs/common';
import { IdentificationController } from './identification.controller';
import { IdentificationService } from './identification.service';

@Module({
  controllers: [IdentificationController],
  providers: [IdentificationService],
  exports: [IdentificationService],
})
export class IdentificationModule {}
