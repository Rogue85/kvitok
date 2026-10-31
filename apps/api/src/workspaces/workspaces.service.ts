import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceDto } from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthUser } from '@kvitok/shared';
import type { Workspace } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listFor(user: AuthUser): Promise<WorkspaceDto[]> {
    const workspaces = await this.prisma.workspace.findMany({
      where: user.isSuperadmin ? {} : { memberships: { some: { userId: user.id } } },
      orderBy: { createdAt: 'asc' },
    });
    return workspaces.map(toWorkspaceDto);
  }

  async create(input: CreateWorkspaceInput, creator: AuthUser): Promise<WorkspaceDto> {
    if (await this.prisma.workspace.findUnique({ where: { slug: input.slug } })) {
      throw errors.conflict(t('api.slugTaken', { slug: input.slug }));
    }

    const workspace = await this.prisma.workspace.create({
      data: {
        id: newId(),
        name: input.name,
        slug: input.slug,
        memberships: { create: { userId: creator.id, role: 'admin' } },
      },
    });
    return toWorkspaceDto(workspace);
  }

  async get(workspaceId: string): Promise<WorkspaceDto> {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (workspace === null) {
      throw errors.notFound(t('api.workspaceNotFound'));
    }
    return toWorkspaceDto(workspace);
  }

  async update(workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceDto> {
    const workspace = await this.prisma.workspace.update({ where: { id: workspaceId }, data: input });
    return toWorkspaceDto(workspace);
  }
}

export function toWorkspaceDto(workspace: Workspace): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    locale: workspace.locale,
    createdAt: workspace.createdAt.toISOString(),
  };
}
