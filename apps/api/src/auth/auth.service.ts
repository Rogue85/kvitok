import { t } from '@kvitok/i18n';
import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse, SessionDto } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthContext } from '../common/request';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toAuthUser } from '../users/users.service';
import { hashPassword, verifyPassword } from './password';
import { generateSessionToken, hashSessionToken } from './session-token';

/** last_seen_at is updated and the session extended at most once per this interval. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

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
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, meta: SessionMeta): Promise<LoginResult | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    // An invited user has no password yet.
    if (user === null || user.passwordHash === null) {
      // Spend as much time as a real check, so as not to reveal whether the email exists.
      await verifyPassword(await this.getDummyHash(), password);
      return null;
    }
    if (user.disabledAt !== null || !(await verifyPassword(user.passwordHash, password))) {
      return null;
    }

    return this.startSession(user, meta);
  }

  async startSession(user: User, meta: SessionMeta): Promise<LoginResult> {
    const token = generateSessionToken();
    const [session] = await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          id: newId(),
          tokenHash: hashSessionToken(token),
          userId: user.id,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
          expiresAt: this.nextExpiry(),
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } }),
    ]);

    return { token, expiresAt: session.expiresAt, auth: { user: toAuthUser(user), sessionId: session.id, token: null } };
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
      await this.prisma.$transaction([
        this.prisma.session.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(now), expiresAt: this.nextExpiry() },
        }),
        this.prisma.user.update({ where: { id: session.userId }, data: { lastSeenAt: new Date(now) } }),
      ]);
    }

    return { user: toAuthUser(session.user), sessionId: session.id, token: null };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' } } },
    });

    const workspaces: MeResponse['workspaces'] = user.memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      workspaceSlug: m.workspace.slug,
      role: m.role,
      isMember: true,
    }));
    if (user.isSuperadmin) {
      // A superadmin works as admin in every workspace, including the ones they are not a member of.
      const others = await this.prisma.workspace.findMany({
        where: { id: { notIn: workspaces.map((w) => w.workspaceId) } },
        orderBy: { createdAt: 'asc' },
      });
      for (const workspace of others) {
        workspaces.push({ workspaceId: workspace.id, workspaceName: workspace.name, workspaceSlug: workspace.slug, role: 'admin', isMember: false });
      }
      for (const workspace of workspaces) workspace.role = 'admin';
    }

    return { user: toAuthUser(user), workspaces };
  }

  async updateProfile(userId: string, name: string): Promise<void> {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const after = await this.prisma.user.update({ where: { id: userId }, data: { name } });
    await this.audit.record({ workspaceId: null, entity: 'user', entityId: userId, action: 'update', before: { name: before.name }, after: { name: after.name } });
  }

  /** Changes the password; every other session of the user ends, unused password links stop working. */
  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (user.passwordHash === null || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw errors.validation([{ path: 'currentPassword', message: t('api.wrongPassword'), code: 'custom' }], t('api.wrongPassword'));
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.session.deleteMany({ where: { userId: user.id, ...(auth.sessionId === null ? {} : { id: { not: auth.sessionId } }) } }),
      this.prisma.passwordToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
    ]);
  }

  async sessions(auth: AuthContext): Promise<SessionDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: auth.user.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      lastSeenAt: s.lastSeenAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      current: s.id === auth.sessionId,
    }));
  }

  async endSession(auth: AuthContext, sessionId: string): Promise<void> {
    const deleted = await this.prisma.session.deleteMany({ where: { id: sessionId, userId: auth.user.id } });
    if (deleted.count === 0) {
      throw errors.notFound();
    }
  }

  /** Signs out everywhere except the current session. */
  async endOtherSessions(auth: AuthContext): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId: auth.user.id, ...(auth.sessionId === null ? {} : { id: { not: auth.sessionId } }) } });
  }

  private nextExpiry(): Date {
    return new Date(Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(generateSessionToken());
    return this.dummyHash;
  }
}
