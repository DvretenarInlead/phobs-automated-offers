import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AUTH_EXPIRED_EVENT, fetchMe } from './api';
import type { MeResponse } from './api';

interface AuthState {
  user: MeResponse | null;
  /** True only during the very first /me lookup. */
  loading: boolean;
  /** Set when a request failed with 401 mid-session; cleared on next login. */
  expired: boolean;
  /**
   * Re-fetch /me. Background refreshes never flip `loading`, so the page tree
   * stays mounted (important for one-time displays like recovery codes).
   */
  refresh: (opts?: { background?: boolean }) => Promise<void>;
  setUser: (u: MeResponse | null) => void;
}

const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  expired: false,
  refresh: async () => undefined,
  setUser: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUserState] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);

  const setUser = useCallback((u: MeResponse | null): void => {
    setUserState(u);
    if (u) setExpired(false);
  }, []);

  const refresh = useCallback(async (opts?: { background?: boolean }): Promise<void> => {
    if (!opts?.background) setLoading(true);
    try {
      const me = await fetchMe();
      setUserState(me);
      if (me) setExpired(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = (): void => {
      setUserState((prev) => {
        if (prev) setExpired(true);
        return null;
      });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, expired, refresh, setUser }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(Ctx);
}
