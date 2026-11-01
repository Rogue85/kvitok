import type { AuthContext } from '../common/request';
import type { PrismaService } from '../prisma/prisma.service';
import { toAuthUser } from '../users/users.service';

/**
 * Checks an authenticated context again, for long-lived connections: null once the session ended,
 * the token was revoked or expired, or the user was disabled. The user comes fresh from the database.
 */
export async function revalidateAuth(prisma: PrismaService, auth: AuthContext): Promise<AuthContext | null> {
  const now = Date.now();
  if (auth.token !== null) {
    const token = await prisma.apiToken.findUnique({ where: { id: auth.token.id }, include: { user: true } });
    const valid =
      token !== null &&
      token.revokedAt === null &&
      (token.expiresAt === null || token.expiresAt.getTime() > now) &&
      token.user.disabledAt === null;
    return valid ? { ...auth, user: toAuthUser(token.user) } : null;
  }
  if (auth.sessionId === null) {
    return null;
  }
  const session = await prisma.session.findUnique({ where: { id: auth.sessionId }, include: { user: true } });
  const valid = session !== null && session.expiresAt.getTime() > now && session.user.disabledAt === null;
  return valid ? { ...auth, user: toAuthUser(session.user) } : null;
}
