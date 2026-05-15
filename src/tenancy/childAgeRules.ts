import { z } from 'zod';

/**
 * Per-property age normalization rules. `donja` = upper bound below which a
 * child is "infant" (omitted entirely). `gornja` = upper bound above which a
 * child is treated as an extra adult instead of a child.
 *
 * Rule semantics (preserves the legacy Make.com behaviour):
 *   age <= donja           -> drop (infant)
 *   donja < age <= gornja  -> keep as child
 *   age > gornja           -> drop from children, +1 adult
 */
export const propertyRuleSchema = z.object({
  name: z.string().min(1),
  donja: z.number().nonnegative(),
  gornja: z.number().positive(),
});
export type PropertyRule = z.infer<typeof propertyRuleSchema>;

export const propertyRulesSchema = z.record(z.string(), propertyRuleSchema);
export type PropertyRules = z.infer<typeof propertyRulesSchema>;

export interface NormalizeInput {
  childAges: number[];
  adults: number;
  propertyId: string;
  rules: PropertyRules;
}

export interface NormalizeResult {
  childAges: number[]; // ages that survived (in original order, dropped removed)
  adults: number;
  numberOfChildren: number;
  /** True if the propertyId had no matching rule. Caller decides how to fail. */
  unknownProperty: boolean;
}

export function normalizeChildAges(input: NormalizeInput): NormalizeResult {
  const rule = input.rules[input.propertyId];
  if (!rule) {
    return {
      childAges: input.childAges.slice(),
      adults: input.adults,
      numberOfChildren: input.childAges.length,
      unknownProperty: true,
    };
  }

  let adults = input.adults;
  const kept: number[] = [];
  for (const age of input.childAges) {
    if (age <= rule.donja) continue; // infant — drop
    if (age <= rule.gornja) {
      kept.push(age);
      continue;
    }
    adults += 1; // counts as extra adult
  }

  return {
    childAges: kept,
    adults,
    numberOfChildren: kept.length,
    unknownProperty: false,
  };
}
