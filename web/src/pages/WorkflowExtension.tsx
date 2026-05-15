import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export function WorkflowExtension(): ReactElement {
  const { user } = useAuth();
  if (user?.role !== 'superadmin') {
    return <div className="text-rose-400 text-sm">Superadmin only.</div>;
  }

  const q = useQuery({
    queryKey: ['workflow-action-definition'],
    queryFn: () => api<Record<string, unknown>>('/workflow-action-definition'),
  });

  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!q.data) return;
    await navigator.clipboard.writeText(JSON.stringify(q.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">HubSpot Workflow Extension</h1>
      <p className="text-slate-400 text-sm max-w-3xl">
        Once your HubSpot public app is created, register this definition as a
        custom workflow action so it appears in every installed portal's
        workflow builder, scoped to deals. HubSpot will invoke{' '}
        <code className="text-emerald-300">{q.data?.actionUrl as string}</code>{' '}
        with a signed JWT in the Authorization header per execution.
      </p>

      <section className="card">
        <h2 className="font-semibold mb-3">How to register</h2>
        <ol className="text-sm text-slate-300 space-y-2 list-decimal pl-5">
          <li>
            In the{' '}
            <a
              className="text-emerald-400 hover:underline"
              href="https://developers.hubspot.com/"
              target="_blank"
              rel="noreferrer"
            >
              HubSpot Developer Portal
            </a>
            , open your app and grab its <em>developer API key</em> and{' '}
            <em>app ID</em>.
          </li>
          <li>
            POST the JSON below to{' '}
            <code className="text-emerald-300">
              https://api.hubapi.com/automation/v4/actions/&lt;appId&gt;?hapikey=&lt;devApiKey&gt;
            </code>
            .
          </li>
          <li>
            HubSpot returns a <code>definitionId</code>. Use{' '}
            <code className="text-emerald-300">PUT</code> on the same path with{' '}
            <code>/&lt;definitionId&gt;</code> to update it later.
          </li>
          <li>
            Flip <code className="text-emerald-300">"published": true</code> in
            the JSON when you're ready to make the action visible to installed
            portals.
          </li>
        </ol>
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Definition</h2>
          <div className="flex items-center gap-3">
            {copied && <span className="text-emerald-400 text-xs">Copied!</span>}
            <button className="btn-secondary text-xs" onClick={copy} disabled={!q.data}>
              Copy JSON
            </button>
          </div>
        </div>
        <pre className="font-mono text-xs bg-slate-950 rounded p-3 overflow-x-auto max-h-[60vh]">
          {q.data ? JSON.stringify(q.data, null, 2) : 'Loading…'}
        </pre>
      </section>
    </div>
  );
}
