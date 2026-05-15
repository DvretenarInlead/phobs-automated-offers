import { loadConfig } from '../config.js';

/**
 * HubSpot Workflow Extension definition for "Phobs Automated Offer".
 *
 * To install/update in HubSpot, send this object as the JSON body of:
 *   POST https://api.hubapi.com/automation/v4/actions/{appId}
 *   PUT  https://api.hubapi.com/automation/v4/actions/{appId}/{definitionId}
 *
 * Authenticate with the developer key for the public-app account (NOT a portal
 * access token). See docs:
 *   https://developers.hubspot.com/docs/api/automation/custom-workflow-actions
 *
 * Once registered the action shows up in the workflow builder of every portal
 * that has the public app installed, scoped to deals. HubSpot invokes
 * `actionUrl` per-execution with a signed JWT in the Authorization header.
 */
export interface WorkflowActionDefinition {
  actionUrl: string;
  published: boolean;
  objectTypes: string[];
  inputFields: InputFieldDef[];
  outputFields: OutputFieldDef[];
  labels: Record<string, LocaleLabels>;
}

interface InputFieldDef {
  typeDefinition: {
    name: string;
    type: 'string' | 'number' | 'enumeration' | 'bool';
    fieldType:
      | 'text'
      | 'number'
      | 'select'
      | 'date'
      | 'booleancheckbox';
    optionsUrl?: string;
  };
  supportedValueTypes: ('STATIC_VALUE' | 'OBJECT_PROPERTY')[];
  isRequired: boolean;
}

interface OutputFieldDef {
  typeDefinition: {
    name: string;
    type: 'string' | 'number';
    fieldType: 'text' | 'number';
  };
}

interface LocaleLabels {
  actionName: string;
  actionDescription: string;
  appDisplayName?: string;
  actionCardContent?: string;
  inputFieldLabels: Record<string, { label: string; description?: string }>;
  outputFieldLabels?: Record<string, { label: string }>;
}

export function buildWorkflowActionDefinition(
  overrides: Partial<WorkflowActionDefinition> = {},
): WorkflowActionDefinition {
  const cfg = loadConfig();
  const actionUrl =
    overrides.actionUrl ?? `${cfg.PUBLIC_BASE_URL}/workflow-actions/process-deal`;

  const inputFields: InputFieldDef[] = [
    field('hs_object_id', 'number', 'number', true),
    field('rezapp___property_id', 'string', 'text', true),
    field('jezik_ponude', 'string', 'text', false),
    field('rezzapp___broj_odraslih', 'number', 'number', true),
    field('child_age_1', 'number', 'number', false),
    field('child_age_2', 'number', 'number', false),
    field('child_age_3', 'number', 'number', false),
    field('child_age_4', 'number', 'number', false),
    field('child_age_5', 'number', 'number', false),
    field('picker_date_check_in', 'number', 'number', true),
    field('picker_date_check_out', 'number', 'number', false),
    field('reservation___nights', 'number', 'number', true),
    field('bluesunrewards___loyaltyid', 'number', 'number', false),
  ];

  const outputFields: OutputFieldDef[] = [
    { typeDefinition: { name: 'status', type: 'string', fieldType: 'text' } },
    { typeDefinition: { name: 'job_id', type: 'string', fieldType: 'text' } },
  ];

  return {
    actionUrl,
    published: false,
    objectTypes: ['DEAL'],
    inputFields,
    outputFields,
    labels: {
      en: {
        actionName: 'Phobs Automated Offer',
        actionDescription:
          'Query Phobs availability for this deal and create a HubSpot quote with the resulting line items.',
        appDisplayName: 'Phobs Offers',
        actionCardContent: 'Generate Phobs offer',
        inputFieldLabels: {
          hs_object_id: { label: 'Deal ID' },
          rezapp___property_id: { label: 'Phobs property ID' },
          jezik_ponude: { label: 'Offer language (e.g. hr, en)' },
          rezzapp___broj_odraslih: { label: 'Number of adults' },
          child_age_1: { label: 'Child age #1' },
          child_age_2: { label: 'Child age #2' },
          child_age_3: { label: 'Child age #3' },
          child_age_4: { label: 'Child age #4' },
          child_age_5: { label: 'Child age #5' },
          picker_date_check_in: { label: 'Check-in (ms epoch)' },
          picker_date_check_out: { label: 'Check-out (ms epoch)' },
          reservation___nights: { label: 'Nights (ms; ÷86_400_000 internally)' },
          bluesunrewards___loyaltyid: { label: 'Loyalty ID (optional, gates access code)' },
        },
        outputFieldLabels: {
          status: { label: 'Status' },
          job_id: { label: 'Job ID' },
        },
      },
    },
    ...overrides,
  };
}

function field(
  name: string,
  type: InputFieldDef['typeDefinition']['type'],
  fieldType: InputFieldDef['typeDefinition']['fieldType'],
  isRequired: boolean,
): InputFieldDef {
  return {
    typeDefinition: { name, type, fieldType },
    supportedValueTypes: ['STATIC_VALUE', 'OBJECT_PROPERTY'],
    isRequired,
  };
}
