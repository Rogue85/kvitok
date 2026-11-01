import { Module } from '@nestjs/common';
import { PasswordLinksService } from './password-links.service';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, PasswordLinksService],
  exports: [UsersService, PasswordLinksService],
})
export class UsersModule {}
