import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Global: every service that changes the configuration records it. The HTTP app adds the controller and the context interceptor. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
