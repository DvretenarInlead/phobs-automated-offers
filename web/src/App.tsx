import type { ReactElement } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Protected } from './components/Protected';
import { Login } from './pages/Login';
import { AcceptInvite } from './pages/AcceptInvite';
import { Dashboard } from './pages/Dashboard';
import { Tenants } from './pages/Tenants';
import { TenantConfig } from './pages/TenantConfig';
import { PhobsProbe } from './pages/PhobsProbe';
import { Activity } from './pages/Activity';
import { Jobs } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { Live } from './pages/Live';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { ManualTrigger } from './pages/ManualTrigger';
import { WorkflowExtension } from './pages/WorkflowExtension';

export function App(): ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
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
        <Route path="activity" element={<Activity />} />
        <Route path="live" element={<Live />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:jobId" element={<JobDetail />} />
        <Route path="probe" element={<PhobsProbe />} />
        <Route path="manual-trigger" element={<ManualTrigger />} />
        <Route path="settings" element={<Settings />} />
        <Route path="users" element={<Users />} />
        <Route path="workflow-extension" element={<WorkflowExtension />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
