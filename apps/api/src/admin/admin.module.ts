import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { UsersAdminController } from './users-admin.controller';
import { UsersAdminService } from './users-admin.service';

@Module({
  imports: [UsersModule, WorkspacesModule],
  controllers: [UsersAdminController],
  providers: [UsersAdminService],
})
export class AdminModule {}
