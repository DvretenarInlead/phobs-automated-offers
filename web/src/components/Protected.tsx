import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Protected({ children }: { children: ReactNode }): ReactElement {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-500 text-sm">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
