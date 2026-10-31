import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@kvitok/shared';
import { hashPassword } from '../auth/password';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  isSuperadmin?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = input.email.toLowerCase();
    if (await this.findByEmail(email)) {
      throw errors.conflict(t('api.userExists', { email }));
    }

    return this.prisma.user.create({
      data: {
        id: newId(),
        email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        isSuperadmin: input.isSuperadmin ?? false,
      },
    });
  }
}

export function toAuthUser(user: Pick<User, 'id' | 'email' | 'name' | 'isSuperadmin'>): AuthUser {
  return { id: user.id, email: user.email, name: user.name, isSuperadmin: user.isSuperadmin };
}
