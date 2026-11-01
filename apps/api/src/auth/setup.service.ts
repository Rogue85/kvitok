import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { SetupInput } from '@kvitok/shared';
import { runAs } from '../audit/audit-context';
import { errors } from '../common/errors';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService, lockSuperadmins } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

/** The first run of an installation: the first superadmin and the first workspace, from the UI instead of the CLI. */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** The setup is open while the installation has no superadmin. */
  async required(): Promise<boolean> {
    return (await this.prisma.user.count({ where: { isSuperadmin: true } })) === 0;
  }

  async run(input: SetupInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      // Concurrent first runs: only one of them creates the superadmin.
      await lockSuperadmins(tx);
      if ((await tx.user.count({ where: { isSuperadmin: true } })) > 0) {
        throw errors.conflict(t('api.setupDone'));
      }
      const user = await this.users.create({ email: input.email, name: input.name, password: input.password, isSuperadmin: true }, tx);
      await runAs({ type: 'user', userId: user.id, name: user.name }, async () => {
        const slug = await this.workspaces.freeSlug(input.workspaceName, tx);
        await this.workspaces.create({ name: input.workspaceName, slug, currency: input.currency }, user, tx);
      });
      return user;
    });
  }
}
