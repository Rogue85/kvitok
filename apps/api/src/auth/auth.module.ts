import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PasswordLinksController } from './password-links.controller';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [
    UsersModule,
    WorkspacesModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [{ name: 'login', ttl: 60_000, limit: config.loginRateLimit }],
    }),
  ],
  controllers: [AuthController, ApiTokensController, SetupController, PasswordLinksController],
  providers: [AuthService, ApiTokensService, SetupService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
