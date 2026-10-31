import type { MeResponse } from '@kvitok/shared';

export function useAuth() {
  const me = useState<MeResponse | null>('auth:me', () => null);
  const loaded = useState('auth:loaded', () => false);

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

  return { me, loaded, fetchMe, login, logout };
}
