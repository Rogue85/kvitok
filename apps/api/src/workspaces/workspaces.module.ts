import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [UsersModule],
  controllers: [WorkspacesController, MembersController],
  providers: [WorkspacesService, MembersService, WorkspaceGuard],
  exports: [WorkspaceGuard],
})
export class WorkspacesModule {}
