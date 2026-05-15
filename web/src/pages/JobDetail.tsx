import { useState } from 'react';
import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Step {
  id: string;
  hubId: string;
  dealId: string | null;
  step: string;
  stepIndex: number;
  status: 'ok' | 'skipped' | 'error' | 'retrying';
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}
interface StepsResponse {
  steps: Step[];
}

export function JobDetail(): ReactElement {
  const { jobId } = useParams<{ jobId: string }>();
  const q = useQuery({
    queryKey: ['job-steps', jobId],
    queryFn: () => api<StepsResponse>(`/jobs/${jobId!}/steps`),
    enabled: Boolean(jobId),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Job detail</h1>
        <div className="text-slate-500 text-sm font-mono">{jobId}</div>
      </div>
      {q.isPending ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : q.error ? (
        <div className="text-rose-400 text-sm">Failed to load steps.</div>
      ) : (
        <div className="space-y-2">
          {q.data?.steps.map((s) => <StepRow key={s.id} step={s} />)}
          {q.data && q.data.steps.length === 0 && (
            <div className="card text-slate-500 text-sm">
              No steps recorded for this job. It may not have started yet or has been pruned.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }): ReactElement {
  const [open, setOpen] = useState(false);
  const colour =
    step.status === 'ok'
      ? 'border-emerald-700 bg-emerald-950/30'
      : step.status === 'error'
        ? 'border-rose-700 bg-rose-950/30'
        : 'border-amber-700 bg-amber-950/30';
  return (
    <div className={`card border ${colour}`}>
      <button
        type="button"
        className="w-full text-left flex items-center justify-between"
        onClick={() => setOpen((x) => !x)}
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-400 w-6 text-right">{step.stepIndex}</span>
          <span className="font-mono text-sm">{step.step}</span>
          <span
            className={
              step.status === 'ok' ? 'pill-ok' : step.status === 'error' ? 'pill-fail' : 'pill-warn'
            }
          >
            {step.status}
          </span>
        </div>
        <div className="text-xs text-slate-400">
          {step.durationMs != null ? `${step.durationMs} ms` : ''} ·{' '}
          {new Date(step.createdAt).toLocaleTimeString()}
        </div>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <Bundle label="Input" value={step.input} />
          <Bundle label="Output" value={step.output} />
          {step.error && (
            <div className="md:col-span-2">
              <div className="text-rose-300 font-medium mb-1">Error</div>
              <pre className="font-mono bg-slate-950 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {step.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Bundle({ label, value }: { label: string; value: unknown }): ReactElement {
  return (
    <div>
      <div className="text-slate-400 mb-1">{label}</div>
      <pre className="font-mono bg-slate-950 rounded p-2 overflow-x-auto max-h-72">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
