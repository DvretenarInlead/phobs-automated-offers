import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

export interface RateFilters {
  global?: {
    exclude_rate_ids?: string[];
    exclude_boards?: string[];
    include_boards?: string[] | null;
    min_available_units?: number;
    max_price_per_night?: number | null;
  };
  units?: Record<
    string,
    {
      include_boards?: string[] | null;
      exclude_boards?: string[];
      exclude_rate_ids?: string[];
      max_results?: number | null;
    }
  >;
}

interface Props {
  value: RateFilters;
  onChange: (next: RateFilters) => void;
}

const BOARD_OPTIONS = ['BB', 'HB', 'FB', 'AI', 'RO'];

export function RateFiltersEditor({ value, onChange }: Props): ReactElement {
  const g = value.global ?? {};
  const u = value.units ?? {};

  const setGlobal = <K extends keyof NonNullable<RateFilters['global']>>(
    k: K,
    v: NonNullable<RateFilters['global']>[K],
  ): void => {
    onChange({ ...value, global: { ...g, [k]: v } });
  };

  const setUnit = (
    unitId: string,
    patch: Partial<NonNullable<RateFilters['units']>[string]>,
  ): void => {
    const existing = u[unitId] ?? {};
    onChange({
      ...value,
      units: { ...u, [unitId]: { ...existing, ...patch } },
    });
  };

  const removeUnit = (unitId: string): void => {
    const next = { ...(u ?? {}) };
    delete next[unitId];
    onChange({ ...value, units: next });
  };

  const [newUnitId, setNewUnitId] = useState('');
  const unitIds = useMemo(() => Object.keys(u).sort(), [u]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-3">Global filters</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TagList
            label="Exclude rate IDs"
            values={g.exclude_rate_ids ?? []}
            onChange={(v) => setGlobal('exclude_rate_ids', v)}
            placeholder="RATE525800"
          />
          <BoardPicker
            label="Exclude boards"
            values={g.exclude_boards ?? []}
            onChange={(v) => setGlobal('exclude_boards', v)}
          />
          <BoardAllowList
            label="Include only these boards"
            value={g.include_boards ?? null}
            onChange={(v) => setGlobal('include_boards', v)}
          />
          <NumberField
            label="Min available units"
            value={g.min_available_units ?? 1}
            onChange={(v) => setGlobal('min_available_units', v)}
            min={0}
          />
          <NullableNumberField
            label="Max price per night"
            value={g.max_price_per_night ?? null}
            onChange={(v) => setGlobal('max_price_per_night', v)}
            min={0}
            step={0.01}
          />
        </div>
      </div>

      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-3">Per-unit overrides</h3>
        <div className="flex items-end gap-2 mb-4">
          <div className="flex-1 max-w-xs">
            <label className="label">Add unit by ID</label>
            <input
              className="input font-mono"
              value={newUnitId}
              onChange={(e) => setNewUnitId(e.target.value)}
              placeholder="17173"
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            disabled={!newUnitId.trim() || newUnitId in u}
            onClick={() => {
              setUnit(newUnitId.trim(), {});
              setNewUnitId('');
            }}
          >
            Add
          </button>
        </div>

        {unitIds.length === 0 ? (
          <div className="text-slate-500 text-sm">No per-unit overrides configured.</div>
        ) : (
          <div className="space-y-3">
            {unitIds.map((unitId) => {
              const cfg = u[unitId] ?? {};
              return (
                <div key={unitId} className="border border-slate-800 rounded p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-mono text-sm">Unit {unitId}</div>
                    <button
                      type="button"
                      className="text-rose-400 hover:text-rose-300 text-xs"
                      onClick={() => removeUnit(unitId)}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <BoardAllowList
                      label="Include only these boards"
                      value={cfg.include_boards ?? null}
                      onChange={(v) => setUnit(unitId, { include_boards: v })}
                    />
                    <BoardPicker
                      label="Exclude boards"
                      values={cfg.exclude_boards ?? []}
                      onChange={(v) => setUnit(unitId, { exclude_boards: v })}
                    />
                    <TagList
                      label="Exclude rate IDs"
                      values={cfg.exclude_rate_ids ?? []}
                      onChange={(v) => setUnit(unitId, { exclude_rate_ids: v })}
                      placeholder="RATE525800"
                    />
                    <NullableNumberField
                      label="Max results (cheapest N)"
                      value={cfg.max_results ?? null}
                      onChange={(v) => setUnit(unitId, { max_results: v })}
                      min={1}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TagList({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
        {values.map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="pill bg-slate-800 hover:bg-rose-900/40 text-slate-200 hover:text-rose-200 cursor-pointer"
            title="click to remove"
          >
            {v} ×
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn-secondary" onClick={add} disabled={!draft.trim()}>
          +
        </button>
      </div>
    </div>
  );
}

function BoardPicker({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
}): ReactElement {
  const toggle = (b: string): void => {
    onChange(values.includes(b) ? values.filter((x) => x !== b) : [...values, b]);
  };
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex flex-wrap gap-1">
        {BOARD_OPTIONS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => toggle(b)}
            className={`pill cursor-pointer ${
              values.includes(b) ? 'bg-rose-900/40 text-rose-200' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {b}
          </button>
        ))}
      </div>
    </div>
  );
}

function BoardAllowList({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-3 mb-2">
        <label className="text-xs text-slate-400">
          <input
            type="checkbox"
            checked={value !== null}
            onChange={(e) => onChange(e.target.checked ? [] : null)}
            className="mr-1.5"
          />
          Restrict to specific boards
        </label>
      </div>
      {value !== null && (
        <div className="flex flex-wrap gap-1">
          {BOARD_OPTIONS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() =>
                onChange(value.includes(b) ? value.filter((x) => x !== b) : [...value, b])
              }
              className={`pill cursor-pointer ${
                value.includes(b)
                  ? 'bg-emerald-900/40 text-emerald-200'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        className="input"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function NullableNumberField({
  label,
  value,
  onChange,
  min,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  step?: number;
}): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(e) => onChange(e.target.checked ? (min ?? 0) : null)}
          title="enable limit"
        />
        <input
          type="number"
          className="input flex-1"
          value={value ?? ''}
          min={min}
          step={step}
          disabled={value === null}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>
    </div>
  );
}
