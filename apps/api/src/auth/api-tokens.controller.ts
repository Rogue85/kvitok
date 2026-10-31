import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CreateApiTokenSchema, type ApiTokenDto, type CreateApiTokenData, type CreatedApiTokenDto } from '@kvitok/shared';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiTokensService } from './api-tokens.service';
import { CurrentAuth } from './decorators';

/** The user's own personal access tokens. Tokens can list them but not create or revoke them. */
@Controller('tokens')
export class ApiTokensController {
  constructor(private readonly apiTokens: ApiTokensService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<ApiTokenDto[]> {
    return this.apiTokens.list(auth.user.id);
  }

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateApiTokenSchema)) body: CreateApiTokenData,
  ): Promise<CreatedApiTokenDto> {
    return this.apiTokens.create(auth.user, body);
  }

  @Delete(':tokenId')
  @HttpCode(204)
  revoke(@CurrentAuth() auth: AuthContext, @Param('tokenId') tokenId: string): Promise<void> {
    return this.apiTokens.revoke(auth.user.id, tokenId);
  }
}
