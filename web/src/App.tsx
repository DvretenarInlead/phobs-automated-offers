import type { ReactElement } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Protected } from './components/Protected';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Tenants } from './pages/Tenants';
import { TenantConfig } from './pages/TenantConfig';
import { PhobsProbe } from './pages/PhobsProbe';

export function App(): ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="tenants/:hubId" element={<TenantConfig />} />
        <Route path="probe" element={<PhobsProbe />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
