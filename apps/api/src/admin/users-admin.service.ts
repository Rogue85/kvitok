import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AdminUserDto, AuditLogDto, CreateUserInput, PasswordLinkDto, SetMembershipInput, UpdateUserInput } from '@kvitok/shared';
import { AuditService, toAuditLogDto } from '../audit/audit.service';
import { errors } from '../common/errors';
import type { AuthContext } from '../common/request';
import { MEMBERSHIP_DEPARTMENTS } from '../departments/department-access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordLinksService } from '../users/password-links.service';
import { UsersService, lockSuperadmins, userStatus } from '../users/users.service';
import { MembersService, toUserAuditDto } from '../workspaces/members.service';

const USER_INCLUDE = {
  memberships: { include: { workspace: true, ...MEMBERSHIP_DEPARTMENTS }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.UserInclude;

type UserWithAccess = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

/** Users of the installation, managed by superadmins. */
@Injectable()
export class UsersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly members: MembersService,
    private readonly passwordLinks: PasswordLinksService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AdminUserDto[]> {
    const users = await this.prisma.user.findMany({ include: USER_INCLUDE, orderBy: { name: 'asc' } });
    return users.map(toAdminUserDto);
  }

  async get(userId: string): Promise<AdminUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: USER_INCLUDE });
    if (user === null) {
      throw errors.notFound(t('api.userNotFound'));
    }
    return toAdminUserDto(user);
  }

  /** Creates an invited user with access to the given workspaces and returns the invitation link. All or nothing. */
  async create(input: CreateUserInput): Promise<{ user: AdminUserDto; link: PasswordLinkDto }> {
    const { userId, link } = await this.prisma.$transaction(async (tx) => {
      const found = await tx.workspace.count({ where: { id: { in: input.memberships.map((m) => m.workspaceId) } } });
      if (found !== input.memberships.length) {
        throw errors.notFound(t('api.workspaceNotFound'));
      }
      const user = await this.users.create({ email: input.email, name: input.name, isSuperadmin: input.isSuperadmin }, tx);
      await this.audit.record({ workspaceId: null, entity: 'user', entityId: user.id, action: 'create', after: toUserAuditDto(user) }, tx);
      for (const membership of input.memberships) {
        await this.members.grant(membership.workspaceId, user.id, membership.role, membership.departments, tx);
      }
      return { userId: user.id, link: await this.passwordLinks.issue(user.id, 'invite', tx) };
    });
    return { user: await this.get(userId), link };
  }

  /** Name, the superadmin flag, disabling and enabling. The installation always keeps an active superadmin. */
  async update(auth: AuthContext, userId: string, input: UpdateUserInput): Promise<AdminUserDto> {
    await this.prisma.$transaction(async (tx) => {
      await lockSuperadmins(tx);
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (user === null) {
        throw errors.notFound(t('api.userNotFound'));
      }
      const disable = input.disabled === true && user.disabledAt === null;
      if (disable && userId === auth.user.id) {
        throw errors.conflict(t('api.cannotDisableSelf'));
      }
      const losesSuperadmin = user.isSuperadmin && user.disabledAt === null && (disable || input.isSuperadmin === false);
      if (losesSuperadmin) {
        const others = await tx.user.count({ where: { isSuperadmin: true, disabledAt: null, id: { not: userId } } });
        if (others === 0) {
          throw errors.conflict(t('api.lastSuperadmin'));
        }
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.isSuperadmin === undefined ? {} : { isSuperadmin: input.isSuperadmin }),
          ...(input.disabled === undefined ? {} : { disabledAt: input.disabled ? (user.disabledAt ?? new Date()) : null }),
        },
      });
      if (disable) {
        await tx.session.deleteMany({ where: { userId } });
        await tx.passwordToken.deleteMany({ where: { userId, usedAt: null } });
      }
      await this.audit.record(
        { workspaceId: null, entity: 'user', entityId: userId, action: 'update', before: toUserAuditDto(user), after: toUserAuditDto(updated) },
        tx,
      );
    });
    return this.get(userId);
  }

  /** An invitation for a user who has not set a password yet, a reset link for the others. */
  async passwordLink(userId: string): Promise<PasswordLinkDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw errors.notFound(t('api.userNotFound'));
    }
    if (user.disabledAt !== null) {
      throw errors.conflict(t('api.userDisabled'));
    }
    const link = await this.passwordLinks.issue(userId, user.passwordHash === null ? 'invite' : 'reset');
    await this.audit.record({ workspaceId: null, entity: 'user', entityId: userId, action: 'password_link', after: { purpose: link.purpose } });
    return link;
  }

  /** Without `departments` a new membership gets every department and an existing one keeps its departments. */
  async setMembership(userId: string, workspaceId: string, input: SetMembershipInput, actorUserId: string): Promise<AdminUserDto> {
    if ((await this.prisma.workspace.count({ where: { id: workspaceId } })) === 0) {
      throw errors.notFound(t('api.workspaceNotFound'));
    }
    const existing = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (existing === null) {
      await this.prisma.$transaction((tx) => this.members.grant(workspaceId, userId, input.role, input.departments, tx));
    } else {
      await this.members.update(workspaceId, userId, input, actorUserId);
    }
    return this.get(userId);
  }

  async removeMembership(userId: string, workspaceId: string, actorUserId: string): Promise<AdminUserDto> {
    await this.members.remove(workspaceId, userId, actorUserId);
    return this.get(userId);
  }

  /** Changes of the user and of their access, in every workspace. */
  async history(userId: string): Promise<AuditLogDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityId: userId, entity: { in: ['user', 'member'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return rows.map(toAuditLogDto);
  }
}

function toAdminUserDto(user: UserWithAccess): AdminUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperadmin: user.isSuperadmin,
    status: userStatus(user),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    memberships: user.memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      role: m.role,
      departments: { allDepartments: m.allDepartments, departmentIds: m.departments.map((d) => d.departmentId) },
    })),
  };
}
