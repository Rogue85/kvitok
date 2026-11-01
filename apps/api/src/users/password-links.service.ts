import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { PasswordLinkDto, PasswordLinkInfoDto } from '@kvitok/shared';
import { hashPassword } from '../auth/password';
import { generateSessionToken, hashSessionToken } from '../auth/session-token';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { PasswordTokenPurpose, Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One-time links to set a password: an invitation for a new user, a reset for an existing one.
 * There is no system mail, so an admin copies the link and passes it on.
 */
@Injectable()
export class PasswordLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** A new link replaces the user's previous unused ones. */
  async issue(
    userId: string,
    purpose: PasswordTokenPurpose,
    db: Pick<Prisma.TransactionClient, 'passwordToken'> = this.prisma,
  ): Promise<PasswordLinkDto> {
    await db.passwordToken.deleteMany({ where: { userId, usedAt: null } });
    const token = generateSessionToken();
    const created = await db.passwordToken.create({
      data: { id: newId(), userId, purpose, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    });
    return { token, purpose, expiresAt: created.expiresAt.toISOString() };
  }

  async info(token: string): Promise<PasswordLinkInfoDto> {
    const link = await this.findValid(this.prisma, token);
    return { email: link.user.email, name: link.user.name, purpose: link.purpose };
  }

  /** Sets the password. A reset ends every session of the user. */
  async accept(token: string, password: string): Promise<User> {
    const passwordHash = await hashPassword(password);
    return this.prisma.$transaction(async (tx) => {
      const link = await this.findValid(tx, token);
      // Only one request may use the link.
      const used = await tx.passwordToken.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count === 0) {
        throw errors.notFound(t('api.passwordLinkInvalid'));
      }
      await tx.passwordToken.deleteMany({ where: { userId: link.userId, usedAt: null } });
      if (link.purpose === 'reset') {
        await tx.session.deleteMany({ where: { userId: link.userId } });
      }
      return tx.user.update({ where: { id: link.userId }, data: { passwordHash } });
    });
  }

  private async findValid(db: Pick<Prisma.TransactionClient, 'passwordToken'>, token: string) {
    const link = await db.passwordToken.findUnique({ where: { tokenHash: hashSessionToken(token) }, include: { user: true } });
    if (link === null || link.usedAt !== null || link.expiresAt.getTime() <= Date.now() || link.user.disabledAt !== null) {
      throw errors.notFound(t('api.passwordLinkInvalid'));
    }
    return link;
  }
}
