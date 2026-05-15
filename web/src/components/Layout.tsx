import type { ReactElement } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { logout } from '../lib/api';

const navBase = [
  { to: '/', label: 'Dashboard' },
  { to: '/tenants', label: 'Tenants' },
  { to: '/activity', label: 'Activity' },
  { to: '/live', label: 'Live' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/probe', label: 'Phobs probe' },
  { to: '/settings', label: 'Settings' },
];
const navSuperadmin = [{ to: '/users', label: 'Users' }];

export function Layout(): ReactElement {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const onLogout = async (): Promise<void> => {
    await logout();
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r border-slate-800 bg-slate-950 flex flex-col">
        <div className="px-4 py-5 border-b border-slate-800">
          <div className="text-sm font-semibold text-emerald-400">Phobs Offers</div>
          <div className="text-xs text-slate-500 mt-0.5">Admin</div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {[...navBase, ...(user?.role === 'superadmin' ? navSuperadmin : [])].map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `block px-3 py-2 text-sm rounded ${
                  isActive
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800 text-xs">
          {user && (
            <>
              <div className="text-slate-300 truncate" title={user.email}>
                {user.email}
              </div>
              <div className="text-slate-500 mb-2">
                {user.role === 'superadmin' ? 'Superadmin' : `Tenant: ${user.scopedHubId ?? '—'}`}
              </div>
              <button onClick={onLogout} className="btn-secondary w-full">
                Sign out
              </button>
            </>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="p-8 max-w-6xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
