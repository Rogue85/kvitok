import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AuthUser, UserStatus } from '@kvitok/shared';
import { hashPassword } from '../auth/password';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  name: string;
  /** Without a password the user is invited and sets it with a password link. */
  password?: string;
  isSuperadmin?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  }

  async create(input: CreateUserInput, db: Pick<Prisma.TransactionClient, 'user'> = this.prisma): Promise<User> {
    const email = input.email.toLowerCase();
    if (await db.user.findUnique({ where: { email } })) {
      throw errors.conflict(t('api.userExists', { email }));
    }

    return db.user.create({
      data: {
        id: newId(),
        email,
        name: input.name,
        passwordHash: input.password === undefined ? null : await hashPassword(input.password),
        isSuperadmin: input.isSuperadmin ?? false,
      },
    });
  }
}

const SUPERADMINS_LOCK = 72_017_001;

/**
 * Serializes changes of who is an active superadmin inside a transaction: the first run, taking the flag, disabling.
 * Without it two concurrent changes could each see the other superadmin and leave none, which reopens the first run.
 */
export async function lockSuperadmins(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMINS_LOCK})`;
}

export function userStatus(user: Pick<User, 'passwordHash' | 'disabledAt'>): UserStatus {
  if (user.disabledAt !== null) return 'disabled';
  return user.passwordHash === null ? 'invited' : 'active';
}

export function toAuthUser(user: Pick<User, 'id' | 'email' | 'name' | 'isSuperadmin'>): AuthUser {
  return { id: user.id, email: user.email, name: user.name, isSuperadmin: user.isSuperadmin };
}
