import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AddMemberInput, AddMemberResult, MemberCandidateDto, MemberDto, PasswordLinkDto, WorkspaceRole } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import type { AuthContext } from '../common/request';
import type { Membership, Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordLinksService } from '../users/password-links.service';
import { UsersService, userStatus } from '../users/users.service';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwordLinks: PasswordLinksService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<MemberDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map(toMemberDto);
  }

  /** Users of the installation who are not members yet and can be given access. */
  async candidates(workspaceId: string): Promise<MemberCandidateDto[]> {
    const users = await this.prisma.user.findMany({
      where: { disabledAt: null, memberships: { none: { workspaceId } } },
      orderBy: { name: 'asc' },
    });
    return users.map((u) => ({ id: u.id, email: u.email, name: u.name, status: userStatus(u) }));
  }

  /** Gives an existing user access, or invites a new person: the account works once they set a password by the link. */
  async add(workspaceId: string, input: AddMemberInput): Promise<AddMemberResult> {
    if ('userId' in input) {
      return { member: await this.grant(workspaceId, input.userId, input.role), link: null };
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await this.users.create({ email: input.email, name: input.name }, tx);
      await this.audit.record({ workspaceId: null, entity: 'user', entityId: user.id, action: 'create', after: toUserAuditDto(user) }, tx);
      const member = await this.grant(workspaceId, user.id, input.role, tx);
      return { member, link: await this.passwordLinks.issue(user.id, 'invite', tx) };
    });
  }

  async grant(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    db: Pick<Prisma.TransactionClient, 'user' | 'membership' | 'auditLog'> = this.prisma,
  ): Promise<MemberDto> {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw errors.notFound(t('api.userNotFound'));
    }
    if (user.disabledAt !== null) {
      throw errors.conflict(t('api.userDisabled'));
    }
    const existing = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (existing !== null) {
      throw errors.conflict(t('api.alreadyMember', { email: user.email }));
    }

    const membership = await db.membership.create({
      data: { workspaceId, userId, role },
      include: { user: true },
    });
    const dto = toMemberDto(membership);
    await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'create', after: dto }, db);
    return dto;
  }

  /**
   * A new invitation for a member who has not set a password yet. Whoever gets the link gets the account,
   * so a workspace admin may take it only for a user whose every access they already manage: not a superadmin
   * and no workspace where the admin is not an admin. Everything else, and every reset, belongs to superadmins.
   */
  async inviteLink(auth: AuthContext, workspaceId: string, userId: string): Promise<PasswordLinkDto> {
    const membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
    if (membership === null) {
      throw errors.notFound(t('api.memberNotFound'));
    }
    if (userStatus(membership.user) !== 'invited') {
      throw errors.conflict(t('api.memberNotInvited'));
    }
    if (!auth.user.isSuperadmin) {
      const foreign = await this.prisma.membership.count({
        where: { userId, workspace: { memberships: { none: { userId: auth.user.id, role: 'admin' } } } },
      });
      if (membership.user.isSuperadmin || foreign > 0) {
        throw errors.forbidden(t('api.inviteLinkForeign'));
      }
    }
    const link = await this.passwordLinks.issue(userId, 'invite');
    await this.audit.record({ workspaceId: null, entity: 'user', entityId: userId, action: 'password_link', after: { purpose: link.purpose } });
    return link;
  }

  async updateRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MemberDto> {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.role === 'admin' && role !== 'admin') {
        await this.assertAnotherAdmin(tx, membership);
      }

      const updated = await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role },
        include: { user: true },
      });
      const dto = toMemberDto(updated);
      await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'update', before: toMemberDto(membership), after: dto }, tx);
      return dto;
    });
  }

  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.role === 'admin') {
        await this.assertAnotherAdmin(tx, membership);
      }
      await tx.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
      await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'delete', before: toMemberDto(membership) }, tx);
    });
  }

  /** An active admin may lose the role only while another active admin remains. A disabled one does not count. */
  private async assertAnotherAdmin(
    tx: Pick<Prisma.TransactionClient, 'membership'>,
    membership: Membership & { user: User },
  ): Promise<void> {
    if (membership.user.disabledAt !== null) {
      return;
    }
    const others = await tx.membership.count({
      where: { workspaceId: membership.workspaceId, role: 'admin', userId: { not: membership.userId }, user: { disabledAt: null } },
    });
    if (others === 0) {
      throw errors.conflict(t('api.lastAdmin'));
    }
  }
}

export function toMemberDto(membership: Membership & { user: User }): MemberDto {
  return {
    userId: membership.userId,
    email: membership.user.email,
    name: membership.user.name,
    role: membership.role,
    status: userStatus(membership.user),
    createdAt: membership.createdAt.toISOString(),
  };
}

/** A user as the audit log records it: never the password. */
export function toUserAuditDto(user: User) {
  return { email: user.email, name: user.name, isSuperadmin: user.isSuperadmin, status: userStatus(user) };
}
