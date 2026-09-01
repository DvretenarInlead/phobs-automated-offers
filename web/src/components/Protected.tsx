import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Protected({ children }: { children: ReactNode }): ReactElement {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-500 text-sm">
        Loading…
      </div>
    );
  }
  if (!user) {
    // Remember where the user was so Login can send them back after auth.
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}
