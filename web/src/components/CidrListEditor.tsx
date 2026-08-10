import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  emptyHint?: string;
}

/**
 * Simple CIDR list editor. Client-side sanity check only — the server
 * revalidates via net.BlockList and returns 400 { error:'invalid_cidrs',
 * invalid: [...] } if anything slips through, which the calling page
 * surfaces. Empty list = allow-all (server treats it that way).
 */
export function CidrListEditor({
  value,
  onChange,
  disabled,
  placeholder = '10.0.0.0/8 or 203.0.113.42',
  emptyHint = 'No entries — all IPs allowed.',
}: Props): ReactElement {
  const [draft, setDraft] = useState('');
  const drafts = useMemo(
    () =>
      draft
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [draft],
  );

  const add = (): void => {
    if (drafts.length === 0) return;
    const merged = Array.from(new Set([...value, ...drafts]));
    onChange(merged);
    setDraft('');
  };

  const remove = (cidr: string): void => {
    onChange(value.filter((c) => c !== cidr));
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="input flex-1 font-mono"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={disabled || drafts.length === 0}
          onClick={add}
        >
          Add
        </button>
      </div>
      {value.length === 0 ? (
        <div className="text-slate-500 text-xs">{emptyHint}</div>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {value.map((cidr) => (
            <li
              key={cidr}
              className="inline-flex items-center gap-2 rounded bg-slate-800 pl-2 pr-1 py-0.5 text-xs font-mono"
            >
              <span>{cidr}</span>
              <button
                type="button"
                className="text-slate-500 hover:text-rose-400 px-1"
                disabled={disabled}
                onClick={() => remove(cidr)}
                aria-label={`Remove ${cidr}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
