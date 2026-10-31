import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { API_TOKEN_PREFIX, type ApiTokenDto, type ApiTokenScope, type AuthUser, type CreateApiTokenData, type CreatedApiTokenDto } from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthContext } from '../common/request';
import type { ApiToken, Workspace } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthUser } from '../users/users.service';
import { generateSessionToken, hashSessionToken } from './session-token';

/** last_used_at is updated at most once per this interval. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const HINT_LENGTH = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<ApiTokenDto[]> {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null },
      include: { workspace: true },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map(toDto);
  }

  async create(user: AuthUser, input: CreateApiTokenData): Promise<CreatedApiTokenDto> {
    const scopes = [...new Set(input.scopes)];
    if (scopes.includes('workspaces:create') && (!user.isSuperadmin || input.workspaceId !== null)) {
      throw errors.validation([{ path: 'scopes', message: t('api.tokenWorkspacesCreateScope'), code: 'custom' }]);
    }
    if (input.workspaceId !== null && !(await this.canOpen(user, input.workspaceId))) {
      throw errors.notFound(t('api.workspaceNotFound'));
    }

    const secret = API_TOKEN_PREFIX + generateSessionToken();
    const token = await this.prisma.apiToken.create({
      data: {
        id: newId(),
        userId: user.id,
        workspaceId: input.workspaceId,
        name: input.name,
        tokenHash: hashSessionToken(secret),
        hint: secret.slice(-HINT_LENGTH),
        scopes,
        expiresAt: input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * DAY_MS),
      },
      include: { workspace: true },
    });
    return { token: toDto(token), secret };
  }

  async revoke(userId: string, tokenId: string): Promise<void> {
    const { count } = await this.prisma.apiToken.updateMany({
      where: { id: tokenId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw errors.notFound(t('api.tokenNotFound'));
  }

  async authenticate(secret: string): Promise<AuthContext | null> {
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashSessionToken(secret) },
      include: { user: true },
    });
    const now = Date.now();
    if (
      token === null ||
      token.revokedAt !== null ||
      (token.expiresAt !== null && token.expiresAt.getTime() <= now) ||
      token.user.disabledAt !== null
    ) {
      return null;
    }

    if (token.lastUsedAt === null || now - token.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date(now) } });
    }

    return {
      user: toAuthUser(token.user),
      sessionId: null,
      token: { id: token.id, name: token.name, scopes: token.scopes as ApiTokenScope[], workspaceId: token.workspaceId },
    };
  }

  private async canOpen(user: AuthUser, workspaceId: string): Promise<boolean> {
    if (user.isSuperadmin) return (await this.prisma.workspace.count({ where: { id: workspaceId } })) > 0;
    return (await this.prisma.membership.count({ where: { workspaceId, userId: user.id } })) > 0;
  }
}

function toDto(token: ApiToken & { workspace: Workspace | null }): ApiTokenDto {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes as ApiTokenScope[],
    workspaceId: token.workspaceId,
    workspaceName: token.workspace?.name ?? null,
    hint: token.hint,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}
