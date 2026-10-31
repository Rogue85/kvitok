import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse } from '@kvitok/shared';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { newId } from '../common/ids';
import type { AuthContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthUser } from '../users/users.service';
import { hashPassword, verifyPassword } from './password';
import { generateSessionToken, hashSessionToken } from './session-token';

/** last_seen_at is updated and the session extended at most once per this interval. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface LoginResult {
  token: string;
  expiresAt: Date;
  auth: AuthContext;
}

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      // Spend as much time as a real check, so as not to reveal whether the email exists.
      await verifyPassword(await this.getDummyHash(), password);
      return null;
    }

    if (user.disabledAt !== null || !(await verifyPassword(user.passwordHash, password))) {
      return null;
    }

    const token = generateSessionToken();
    const session = await this.prisma.session.create({
      data: {
        id: newId(),
        tokenHash: hashSessionToken(token),
        userId: user.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        expiresAt: this.nextExpiry(),
      },
    });

    return { token, expiresAt: session.expiresAt, auth: { user: toAuthUser(user), sessionId: session.id } };
  }

  async authenticate(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });
    if (session === null) {
      return null;
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.user.disabledAt !== null) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now), expiresAt: this.nextExpiry() },
      });
    }

    return { user: toAuthUser(session.user), sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' } } },
    });

    return {
      user: toAuthUser(user),
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspaceId,
        workspaceName: m.workspace.name,
        workspaceSlug: m.workspace.slug,
        role: m.role,
      })),
    };
  }

  private nextExpiry(): Date {
    return new Date(Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(generateSessionToken());
    return this.dummyHash;
  }
}
