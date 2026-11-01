import type { MeResponse, SetupInput, SetupStatusDto } from '@kvitok/shared';

export function useAuth() {
  const me = useState<MeResponse | null>('auth:me', () => null);
  const loaded = useState('auth:loaded', () => false);
  /** null until asked: whether the installation still needs its first superadmin. */
  const setupRequired = useState<boolean | null>('auth:setupRequired', () => null);

  async function fetchMe(): Promise<void> {
    try {
      me.value = await api<MeResponse>('/auth/me');
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      me.value = null;
    } finally {
      loaded.value = true;
    }
  }

  async function login(email: string, password: string): Promise<void> {
    me.value = await api<MeResponse>('/auth/login', { method: 'POST', body: { email, password } });
    loaded.value = true;
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    me.value = null;
    await navigateTo('/login');
  }

  async function checkSetup(): Promise<boolean> {
    setupRequired.value ??= (await api<SetupStatusDto>('/setup')).required;
    return setupRequired.value;
  }

  /** The first run: creates the first superadmin and workspace and signs in. */
  async function setup(input: SetupInput): Promise<void> {
    me.value = await api<MeResponse>('/setup', { method: 'POST', body: input });
    setupRequired.value = false;
    loaded.value = true;
  }

  /** Sets the password by an invitation or reset link and signs in. */
  async function acceptPasswordLink(token: string, password: string): Promise<void> {
    me.value = await api<MeResponse>(`/password-links/${encodeURIComponent(token)}`, { method: 'POST', body: { password } });
    loaded.value = true;
  }

  return { me, loaded, fetchMe, login, logout, checkSetup, setup, acceptPasswordLink };
}
