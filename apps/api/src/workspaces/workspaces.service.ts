import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceDto } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthUser } from '@kvitok/shared';
import type { Workspace } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
    const dto = toWorkspaceDto(workspace);
    await this.audit.record({ workspaceId: workspace.id, entity: 'workspace', entityId: workspace.id, action: 'create', after: dto });
    return dto;
  }

  async get(workspaceId: string): Promise<WorkspaceDto> {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (workspace === null) {
      throw errors.notFound(t('api.workspaceNotFound'));
    }
    return toWorkspaceDto(workspace);
  }

  async update(workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceDto> {
    const before = await this.get(workspaceId);
    const workspace = await this.prisma.workspace.update({ where: { id: workspaceId }, data: input });
    const dto = toWorkspaceDto(workspace);
    await this.audit.record({ workspaceId, entity: 'workspace', entityId: workspaceId, action: 'update', before, after: dto });
    return dto;
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
