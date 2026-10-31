import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AddMemberInput, MemberDto, WorkspaceRole } from '@kvitok/shared';
import { errors } from '../common/errors';
import type { Membership, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  async list(workspaceId: string): Promise<MemberDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map(toMemberDto);
  }

  async add(workspaceId: string, input: AddMemberInput): Promise<MemberDto> {
    let user = await this.users.findByEmail(input.email);

    if (user === null) {
      if (input.name === undefined || input.password === undefined) {
        throw errors.validation(
          [{ path: 'password', message: t('api.newUserNeedsNameAndPassword'), code: 'custom' }],
          t('api.userNotFoundCreate'),
        );
      }
      user = await this.users.create({ email: input.email, name: input.name, password: input.password });
    }

    const existing = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (existing !== null) {
      throw errors.conflict(t('api.alreadyMember', { email: user.email }));
    }

    const membership = await this.prisma.membership.create({
      data: { workspaceId, userId: user.id, role: input.role },
      include: { user: true },
    });
    return toMemberDto(membership);
  }

  async updateRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MemberDto> {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.role === 'admin' && role !== 'admin') {
        await this.assertNotLastAdmin(tx, workspaceId);
      }

      const updated = await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role },
        include: { user: true },
      });
      return toMemberDto(updated);
    });
  }

  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (membership === null) {
        throw errors.notFound(t('api.memberNotFound'));
      }
      if (membership.role === 'admin') {
        await this.assertNotLastAdmin(tx, workspaceId);
      }
      await tx.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    });
  }

  private async assertNotLastAdmin(
    tx: Pick<PrismaService, 'membership'>,
    workspaceId: string,
  ): Promise<void> {
    const admins = await tx.membership.count({ where: { workspaceId, role: 'admin' } });
    if (admins <= 1) {
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
    createdAt: membership.createdAt.toISOString(),
  };
}
