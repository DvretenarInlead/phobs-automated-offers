import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { fetchMe } from './api';
import type { MeResponse } from './api';

interface AuthState {
  user: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (u: MeResponse | null) => void;
}

const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => undefined,
  setUser: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      setUser(await fetchMe());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, refresh, setUser }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(Ctx);
}
