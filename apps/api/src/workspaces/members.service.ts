import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  canSeeDepartment,
  type AddMemberInput,
  type AddMemberResult,
  type MemberCandidateDto,
  type MemberDepartmentsInput,
  type MemberDto,
  type PasswordLinkDto,
  type UpdateMemberInput,
  type WorkspaceRole,
} from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import type { AuthContext } from '../common/request';
import { MEMBERSHIP_DEPARTMENTS, membershipScope } from '../departments/department-access';
import type { Membership, Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OPEN_TICKET_STATUSES, publishAssigneeChanges, removeAssignees, settleEach } from '../tickets/assignment';
import { SYSTEM_ACTOR, type Actor } from '../tickets/ticket-events';
import { PasswordLinksService } from '../users/password-links.service';
import { UsersService, userStatus } from '../users/users.service';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwordLinks: PasswordLinksService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(workspaceId: string): Promise<MemberDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: MEMBER_INCLUDE,
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
      return { member: await this.prisma.$transaction((tx) => this.grant(workspaceId, input.userId, input.role, input.departments, tx)), link: null };
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await this.users.create({ email: input.email, name: input.name }, tx);
      await this.audit.record({ workspaceId: null, entity: 'user', entityId: user.id, action: 'create', after: toUserAuditDto(user) }, tx);
      const member = await this.grant(workspaceId, user.id, input.role, input.departments, tx);
      return { member, link: await this.passwordLinks.issue(user.id, 'invite', tx) };
    });
  }

  /** A new membership; without `departments` — every department. */
  async grant(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    departments: MemberDepartmentsInput | undefined,
    db: Prisma.TransactionClient,
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

    const access = await this.departmentsFor(db, workspaceId, role, departments);
    await db.membership.create({ data: { workspaceId, userId, role, allDepartments: access.allDepartments } });
    await db.membershipDepartment.createMany({ data: access.departmentIds.map((departmentId) => ({ workspaceId, userId, departmentId })) });
    const membership = await db.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } }, include: MEMBER_INCLUDE });
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

  /**
   * Changes the role and the departments. An admin always has every department. The member's open tickets that the change
   * affects are settled afterwards, as after a department change: tickets in departments they lose (unless the workspace
   * keeps assignees' access they leave them), and every one when they become a viewer, who no longer counts as the
   * department's assignee. A ticket left without an assignee of its department may be handed out again.
   */
  async update(workspaceId: string, userId: string, input: UpdateMemberInput, actorUserId: string | null): Promise<MemberDto> {
    const { dto, affected } = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: MEMBER_INCLUDE });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      const role = input.role ?? membership.role;
      if (membership.role === 'admin' && role !== 'admin') {
        await this.assertAnotherAdmin(tx, membership);
      }
      // A promoted admin gets every department; otherwise the departments change only when given.
      const departments = input.departments ?? (role === 'admin' ? { allDepartments: true, departmentIds: [] } : undefined);
      const access = departments === undefined ? null : await this.departmentsFor(tx, workspaceId, role, departments);

      await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role, ...(access ? { allDepartments: access.allDepartments } : {}) },
      });
      if (access) {
        await tx.membershipDepartment.deleteMany({ where: { workspaceId, userId } });
        await tx.membershipDepartment.createMany({ data: access.departmentIds.map((departmentId) => ({ workspaceId, userId, departmentId })) });
      }
      const updated = await tx.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } }, include: MEMBER_INCLUDE });
      const affected = updated.user.isSuperadmin ? [] : await this.affectedTickets(tx, workspaceId, userId, membership, updated);
      const dto = toMemberDto(updated);
      await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'update', before: toMemberDto(membership), after: dto }, tx);
      return { dto, affected };
    });
    const changes = await settleEach(this.prisma, affected, actorUserId ? { type: 'user', id: actorUserId } : SYSTEM_ACTOR, 'access_removed');
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, changes, actorUserId);
    for (const change of changes) {
      await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId: change.ticketId });
    }
    await this.realtime.publish(workspaceId, { type: 'access.changed', userId });
    return dto;
  }

  /** The member's switch for tickets handed out in turn. Turning it off keeps their tickets. */
  async setAccepting(workspaceId: string, userId: string, accepting: boolean): Promise<MemberDto> {
    const dto = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: MEMBER_INCLUDE });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.acceptingTickets === accepting) {
        return toMemberDto(membership);
      }
      const updated = await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { acceptingTickets: accepting },
        include: MEMBER_INCLUDE,
      });
      const after = toMemberDto(updated);
      await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'update', before: toMemberDto(membership), after }, tx);
      return after;
    });
    // Their header and members lists show the switch.
    await this.realtime.publish(workspaceId, { type: 'access.changed', userId });
    return dto;
  }

  /**
   * Removes the member and clears their assignments in the workspace, closed tickets too: inviting them again must not
   * bring back tickets nobody gave them. The timeline keeps who worked on what. Their open tickets are then settled, so
   * a department may hand them out again.
   */
  async remove(workspaceId: string, userId: string, actorUserId: string | null = null): Promise<void> {
    const actor: Actor = actorUserId ? { type: 'user', id: actorUserId } : SYSTEM_ACTOR;
    const open = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: MEMBER_INCLUDE });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.role === 'admin') {
        await this.assertAnotherAdmin(tx, membership);
      }
      const assigned = await tx.ticket.findMany({
        where: { workspaceId, assignees: { some: { userId } } },
        select: { id: true, workspaceId: true, departmentId: true, status: true },
      });
      const open: string[] = [];
      for (const ticket of assigned) {
        if ((OPEN_TICKET_STATUSES as readonly string[]).includes(ticket.status)) {
          await removeAssignees(tx, ticket, [userId], actor, { reason: 'access_removed', departmentId: ticket.departmentId });
          open.push(ticket.id);
        }
      }
      await tx.ticketAssignee.deleteMany({ where: { workspaceId, userId } });
      await tx.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
      await this.audit.record({ workspaceId, entity: 'member', entityId: userId, action: 'delete', before: toMemberDto(membership) }, tx);
      return open;
    });
    const changes = await settleEach(this.prisma, open, actor, 'access_removed');
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, changes, actorUserId);
    for (const ticketId of open) {
      await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    }
    await this.realtime.publish(workspaceId, { type: 'access.changed', userId });
  }

  /** What to store: admins always have every department; a list holds departments of this workspace only. */
  private async departmentsFor(
    db: Pick<Prisma.TransactionClient, 'department'>,
    workspaceId: string,
    role: WorkspaceRole,
    departments: MemberDepartmentsInput | undefined,
  ): Promise<MemberDepartmentsInput> {
    if (departments === undefined || departments.allDepartments) {
      return { allDepartments: true, departmentIds: [] };
    }
    if (role === 'admin') {
      throw errors.validation([{ path: 'departments', message: t('api.adminSeesAllDepartments'), code: 'custom' }]);
    }
    const departmentIds = [...new Set(departments.departmentIds)];
    const found = await db.department.count({ where: { workspaceId, id: { in: departmentIds } } });
    if (found !== departmentIds.length) {
      throw errors.validation([{ path: 'departments.departmentIds', message: t('api.unknownDepartments'), code: 'custom' }]);
    }
    return { allDepartments: false, departmentIds };
  }

  /**
   * The member's open tickets a change of their membership affects: those in departments they no longer see, and all of
   * them when they become a viewer. Tickets where they already were a guest are not touched: nothing changed for them.
   */
  private async affectedTickets(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    userId: string,
    before: Membership & { departments: Array<{ departmentId: string }> },
    after: Membership & { departments: Array<{ departmentId: string }> },
  ): Promise<string[]> {
    const tickets = await tx.ticket.findMany({
      where: { workspaceId, assignees: { some: { userId } }, status: { in: [...OPEN_TICKET_STATUSES] } },
      select: { id: true, departmentId: true },
    });
    if (after.role === 'viewer' && before.role !== 'viewer') {
      return tickets.map((ticket) => ticket.id);
    }
    const [was, is] = await Promise.all([membershipScope(tx, workspaceId, before), membershipScope(tx, workspaceId, after)]);
    return tickets.filter((ticket) => canSeeDepartment(was, ticket.departmentId) && !canSeeDepartment(is, ticket.departmentId)).map((ticket) => ticket.id);
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

const MEMBER_INCLUDE = { user: true, ...MEMBERSHIP_DEPARTMENTS } satisfies Prisma.MembershipInclude;

export function toMemberDto(membership: Membership & { user: User; departments: Array<{ departmentId: string }> }): MemberDto {
  return {
    userId: membership.userId,
    email: membership.user.email,
    name: membership.user.name,
    role: membership.role,
    departments: { allDepartments: membership.allDepartments, departmentIds: membership.departments.map((d) => d.departmentId) },
    status: userStatus(membership.user),
    acceptingTickets: membership.acceptingTickets,
    createdAt: membership.createdAt.toISOString(),
  };
}

/** A user as the audit log records it: never the password. */
export function toUserAuditDto(user: User) {
  return { email: user.email, name: user.name, isSuperadmin: user.isSuperadmin, status: userStatus(user) };
}
