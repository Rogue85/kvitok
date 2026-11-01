import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { slugify, type CreateWorkspaceInput, type UpdateWorkspaceInput, type WorkspaceDto } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { AuthUser } from '@kvitok/shared';
import type { Prisma, Workspace } from '../generated/prisma/client';
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

  async create(
    input: CreateWorkspaceInput,
    creator: Pick<AuthUser, 'id'>,
    db: Pick<Prisma.TransactionClient, 'workspace' | 'auditLog'> = this.prisma,
  ): Promise<WorkspaceDto> {
    if (await db.workspace.findUnique({ where: { slug: input.slug } })) {
      throw errors.conflict(t('api.slugTaken', { slug: input.slug }));
    }

    const workspace = await db.workspace.create({
      data: {
        id: newId(),
        name: input.name,
        slug: input.slug,
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        memberships: { create: { userId: creator.id, role: 'admin' } },
      },
    });
    const dto = toWorkspaceDto(workspace);
    await this.audit.record({ workspaceId: workspace.id, entity: 'workspace', entityId: workspace.id, action: 'create', after: dto }, db);
    return dto;
  }

  /** A free slug from the workspace name: `support`, then `support-2`, `support-3`… */
  async freeSlug(name: string, db: Pick<Prisma.TransactionClient, 'workspace'> = this.prisma): Promise<string> {
    const base = slugify(name).slice(0, 40).replace(/-+$/, '');
    const root = base.length >= 2 ? base : 'support';
    const taken = new Set((await db.workspace.findMany({ where: { slug: { startsWith: root } }, select: { slug: true } })).map((w) => w.slug));
    let slug = root;
    for (let n = 2; taken.has(slug); n += 1) slug = `${root}-${n}`;
    return slug;
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
    currency: workspace.currency,
    createdAt: workspace.createdAt.toISOString(),
  };
}
