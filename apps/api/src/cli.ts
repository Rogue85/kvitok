import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { newId } from './common/ids';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { UsersModule } from './users/users.module';
import { UsersService } from './users/users.service';

@Module({ imports: [ConfigModule, PrismaModule, UsersModule] })
class CliModule {}

const USAGE = `Usage:
  cli user:create --email <email> --password <password> --name <name> [--superadmin]
  cli seed:dev`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
  const users = app.get(UsersService);
  const prisma = app.get(PrismaService);

  try {
    switch (command) {
      case 'user:create': {
        const { values } = parseArgs({
          args: rest,
          options: {
            email: { type: 'string' },
            password: { type: 'string' },
            name: { type: 'string' },
            superadmin: { type: 'boolean', default: false },
          },
        });
        if (!values.email || !values.password || !values.name) {
          throw new Error(USAGE);
        }
        const user = await users.create({
          email: values.email,
          password: values.password,
          name: values.name,
          isSuperadmin: values.superadmin,
        });
        console.log(`Created user ${user.email} (${user.id})`);
        break;
      }

      case 'seed:dev': {
        const email = 'admin@example.com';
        const password = 'admin12345';
        const admin =
          (await users.findByEmail(email)) ??
          (await users.create({ email, password, name: 'Admin', isSuperadmin: true }));

        const workspace =
          (await prisma.workspace.findUnique({ where: { slug: 'demo' } })) ??
          (await prisma.workspace.create({ data: { id: newId(), name: 'Demo', slug: 'demo' } }));

        await prisma.membership.upsert({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: admin.id } },
          update: {},
          create: { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
        });

        console.log(`Seeded workspace "${workspace.name}". Login: ${email} / ${password}`);
        break;
      }

      default:
        throw new Error(USAGE);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
