import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

// Mirror of the server-side zod schema in src/tenancy/overrides.ts. The
// server normalises the value on GET, so we always receive a fully-populated
// object; the UI just edits it.
export interface Overrides {
  input_field_map: {
    deal_id: string;
    property_id: string;
    language: string;
    adults: string;
    fallback_adults: string;
    child_ages: string[];
    check_in_ms: string;
    check_out_ms: string;
    nights_ms: string;
    loyalty_id: string;
  };
  output_field_map: {
    quote_link: string;
    quote_id: string;
    availability_status: string;
    num_children: string;
    adults: string;
    child_age_slots: string[];
  };
  quote_defaults: {
    expiration_days: number;
    title_template: string;
    currency_fallback: string;
  };
  skip_conditions: SkipCondition[];
  loyalty_rule: {
    trigger_property: string;
    trigger_condition: 'present' | 'absent' | 'truthy' | 'falsy';
  };
  default_lang: string;
  product_sku_template: string;
}

export interface SkipCondition {
  property: string;
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'present' | 'absent' | 'truthy' | 'falsy';
  values?: (string | number | boolean | null)[];
}

const SKIP_OPS: SkipCondition['operator'][] = [
  'eq',
  'neq',
  'in',
  'not_in',
  'present',
  'absent',
  'truthy',
  'falsy',
];
const OPS_TAKING_VALUES = new Set(['eq', 'neq', 'in', 'not_in']);
const LOYALTY_OPS = ['present', 'absent', 'truthy', 'falsy'] as const;

interface Props {
  value: Overrides;
  onChange: (next: Overrides) => void;
}

export function OverridesEditor({ value, onChange }: Props): ReactElement {
  const patch = <K extends keyof Overrides>(k: K, v: Overrides[K]): void =>
    onChange({ ...value, [k]: v });
  const patchIfm = (kv: Partial<Overrides['input_field_map']>): void =>
    patch('input_field_map', { ...value.input_field_map, ...kv });
  const patchOfm = (kv: Partial<Overrides['output_field_map']>): void =>
    patch('output_field_map', { ...value.output_field_map, ...kv });
  const patchQd = (kv: Partial<Overrides['quote_defaults']>): void =>
    patch('quote_defaults', { ...value.quote_defaults, ...kv });
  const patchLr = (kv: Partial<Overrides['loyalty_rule']>): void =>
    patch('loyalty_rule', { ...value.loyalty_rule, ...kv });

  return (
    <div className="space-y-8">
      {/* Input field map */}
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-1">Input field mapping</h3>
        <p className="text-slate-500 text-xs mb-3">
          Names of the JSON keys the HubSpot workflow sends in the webhook body. Change these if
          you rename a HubSpot property so no code deploy is needed.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Deal ID">
            <input
              className="input font-mono"
              value={value.input_field_map.deal_id}
              onChange={(e) => patchIfm({ deal_id: e.target.value })}
            />
          </Field>
          <Field label="Property ID">
            <input
              className="input font-mono"
              value={value.input_field_map.property_id}
              onChange={(e) => patchIfm({ property_id: e.target.value })}
            />
          </Field>
          <Field label="Language code">
            <input
              className="input font-mono"
              value={value.input_field_map.language}
              onChange={(e) => patchIfm({ language: e.target.value })}
            />
          </Field>
          <Field label="Default language (fallback)">
            <input
              className="input"
              maxLength={8}
              value={value.default_lang}
              onChange={(e) => patch('default_lang', e.target.value)}
            />
          </Field>
          <Field label="Adults (primary)">
            <input
              className="input font-mono"
              value={value.input_field_map.adults}
              onChange={(e) => patchIfm({ adults: e.target.value })}
            />
          </Field>
          <Field label="Adults (fallback)">
            <input
              className="input font-mono"
              value={value.input_field_map.fallback_adults}
              onChange={(e) => patchIfm({ fallback_adults: e.target.value })}
            />
          </Field>
          <Field label="Check-in (ms epoch)">
            <input
              className="input font-mono"
              value={value.input_field_map.check_in_ms}
              onChange={(e) => patchIfm({ check_in_ms: e.target.value })}
            />
          </Field>
          <Field label="Check-out (ms epoch)">
            <input
              className="input font-mono"
              value={value.input_field_map.check_out_ms}
              onChange={(e) => patchIfm({ check_out_ms: e.target.value })}
            />
          </Field>
          <Field label="Nights (ms)">
            <input
              className="input font-mono"
              value={value.input_field_map.nights_ms}
              onChange={(e) => patchIfm({ nights_ms: e.target.value })}
            />
          </Field>
          <Field label="Loyalty ID">
            <input
              className="input font-mono"
              value={value.input_field_map.loyalty_id}
              onChange={(e) => patchIfm({ loyalty_id: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Child-age input keys (comma-separated, ordered)">
            <input
              className="input font-mono"
              value={value.input_field_map.child_ages.join(', ')}
              onChange={(e) =>
                patchIfm({
                  child_ages: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
      </div>

      {/* Output field map */}
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-1">Output field mapping</h3>
        <p className="text-slate-500 text-xs mb-3">
          HubSpot deal property names we write results back to.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Quote link property">
            <input
              className="input font-mono"
              value={value.output_field_map.quote_link}
              onChange={(e) => patchOfm({ quote_link: e.target.value })}
            />
          </Field>
          <Field label="Quote ID property">
            <input
              className="input font-mono"
              value={value.output_field_map.quote_id}
              onChange={(e) => patchOfm({ quote_id: e.target.value })}
            />
          </Field>
          <Field label="Availability status property">
            <input
              className="input font-mono"
              value={value.output_field_map.availability_status}
              onChange={(e) => patchOfm({ availability_status: e.target.value })}
            />
          </Field>
          <Field label="Number of children">
            <input
              className="input font-mono"
              value={value.output_field_map.num_children}
              onChange={(e) => patchOfm({ num_children: e.target.value })}
            />
          </Field>
          <Field label="Adults (normalised)">
            <input
              className="input font-mono"
              value={value.output_field_map.adults}
              onChange={(e) => patchOfm({ adults: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Child-age output slots (comma-separated, ordered)">
            <input
              className="input font-mono"
              value={value.output_field_map.child_age_slots.join(', ')}
              onChange={(e) =>
                patchOfm({
                  child_age_slots: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
      </div>

      {/* Quote defaults */}
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-1">Quote defaults</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Expiration (days)">
            <input
              type="number"
              min={1}
              max={365}
              className="input"
              value={value.quote_defaults.expiration_days}
              onChange={(e) => patchQd({ expiration_days: Number(e.target.value) })}
            />
          </Field>
          <Field label="Currency fallback">
            <input
              className="input"
              maxLength={8}
              value={value.quote_defaults.currency_fallback}
              onChange={(e) => patchQd({ currency_fallback: e.target.value })}
            />
          </Field>
          <div />
          <div className="md:col-span-3">
            <Field
              label={
                <>
                  Quote title template — supports <code className="text-emerald-400">{'{dealId}'}</code>{' '}
                  and <code className="text-emerald-400">{'{portalId}'}</code>
                </>
              }
            >
              <input
                className="input"
                maxLength={500}
                value={value.quote_defaults.title_template}
                onChange={(e) => patchQd({ title_template: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </div>

      {/* Product SKU template */}
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-1">Product SKU template</h3>
        <p className="text-slate-500 text-xs mb-3">
          Substitutes <code className="text-emerald-400">{'{portalId}'}</code>,{' '}
          <code className="text-emerald-400">{'{unitId}'}</code>,{' '}
          <code className="text-emerald-400">{'{rateId}'}</code>. Products are found-or-created by
          this SKU, so changing it after the fact will orphan the existing ones.
        </p>
        <input
          className="input font-mono"
          maxLength={256}
          value={value.product_sku_template}
          onChange={(e) => patch('product_sku_template', e.target.value)}
        />
      </div>

      {/* Loyalty rule */}
      <div>
        <h3 className="font-medium text-sm text-slate-300 mb-1">Loyalty access-code trigger</h3>
        <p className="text-slate-500 text-xs mb-3">
          Decides when the tenant's loyalty <code>access_code</code> is attached to the Phobs
          request.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Trigger property">
            <input
              className="input font-mono"
              value={value.loyalty_rule.trigger_property}
              onChange={(e) => patchLr({ trigger_property: e.target.value })}
            />
          </Field>
          <Field label="Condition">
            <select
              className="input"
              value={value.loyalty_rule.trigger_condition}
              onChange={(e) =>
                patchLr({ trigger_condition: e.target.value as Overrides['loyalty_rule']['trigger_condition'] })
              }
            >
              {LOYALTY_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {/* Skip conditions */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-medium text-sm text-slate-300">Skip conditions</h3>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() =>
              patch('skip_conditions', [
                ...value.skip_conditions,
                { property: '', operator: 'eq', values: [''] },
              ])
            }
          >
            + Add condition
          </button>
        </div>
        <p className="text-slate-500 text-xs mb-3">
          Any matching condition (OR semantics) causes the pipeline to exit with{' '}
          <code>status=&quot;skipped&quot;</code> before touching Phobs or HubSpot. Values-taking
          operators (eq/neq/in/not_in) treat numeric HubSpot strings as numbers so{' '}
          <code>&quot;5&quot;</code> matches <code>5</code>.
        </p>
        <SkipConditionsList
          conditions={value.skip_conditions}
          onChange={(cs) => patch('skip_conditions', cs)}
        />
      </div>
    </div>
  );
}

function SkipConditionsList({
  conditions,
  onChange,
}: {
  conditions: SkipCondition[];
  onChange: (next: SkipCondition[]) => void;
}): ReactElement {
  const update = (i: number, patch: Partial<SkipCondition>): void => {
    onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  };
  const remove = (i: number): void => onChange(conditions.filter((_, j) => j !== i));

  const rows = useMemo(
    () =>
      conditions.map((c, i) => (
        <div key={i} className="border border-slate-800 rounded p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
          <div className="md:col-span-4">
            <label className="label">Property</label>
            <input
              className="input font-mono"
              value={c.property}
              onChange={(e) => update(i, { property: e.target.value })}
              placeholder="dealstage"
            />
          </div>
          <div className="md:col-span-3">
            <label className="label">Operator</label>
            <select
              className="input"
              value={c.operator}
              onChange={(e) => {
                const op = e.target.value as SkipCondition['operator'];
                update(i, {
                  operator: op,
                  values: OPS_TAKING_VALUES.has(op) ? (c.values ?? ['']) : undefined,
                });
              }}
            >
              {SKIP_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-4">
            {OPS_TAKING_VALUES.has(c.operator) ? (
              <ValuesInput
                op={c.operator}
                values={c.values ?? []}
                onChange={(vs) => update(i, { values: vs })}
              />
            ) : (
              <div className="text-slate-500 text-xs h-full flex items-end pb-2">
                No values needed for this operator.
              </div>
            )}
          </div>
          <div className="md:col-span-1">
            <button
              type="button"
              className="text-rose-400 hover:text-rose-300 text-sm"
              onClick={() => remove(i)}
            >
              Remove
            </button>
          </div>
        </div>
      )),
    [conditions],
  );

  if (conditions.length === 0) {
    return (
      <div className="text-slate-500 text-sm py-2">
        No skip conditions. All deals pass through the pipeline.
      </div>
    );
  }
  return <div className="space-y-2">{rows}</div>;
}

function ValuesInput({
  op,
  values,
  onChange,
}: {
  op: SkipCondition['operator'];
  values: (string | number | boolean | null)[];
  onChange: (vs: (string | number | boolean | null)[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState(values.join(', '));
  const commit = (raw: string): void => {
    setDraft(raw);
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Numeric values kept as strings — the server coerces at compare time.
    onChange(list);
  };
  return (
    <div>
      <label className="label">{op === 'eq' || op === 'neq' ? 'Value' : 'Values (comma-separated)'}</label>
      <input
        className="input font-mono"
        value={draft}
        onChange={(e) => commit(e.target.value)}
        placeholder={op === 'eq' || op === 'neq' ? 'closedlost' : 'closedlost, closedwon'}
      />
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }): ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}
