import { db } from './db.js';
import type { RegulatedWorkloadMode } from './regulated-workloads.js';

export type RegulatedContentCategory = 'phi' | 'education_record' | 'broker_dealer_record';

export interface RegulatedContentFinding {
  category: RegulatedContentCategory;
  field: string;
  signals: string[];
}

const RULES: Array<{
  category: RegulatedContentCategory;
  context: Array<[string, RegExp]>;
  identity: Array<[string, RegExp]>;
}> = [
  {
    category: 'phi',
    context: [
      ['diagnosis', /\bdiagnos(?:is|ed|tic)\b/i],
      ['medical_record', /\bmedical\s+record\b|\bmrn\b/i],
      ['treatment', /\btreatment\s+plan\b|\bprescription\b|\bmedication\b/i],
      ['health_plan', /\bhealth\s+(?:plan|insurance)\b|\bclaim\s+(?:number|id)\b/i],
    ],
    identity: [
      ['patient', /\bpatient\b/i],
      ['date_of_birth', /\b(?:date\s+of\s+birth|dob)\b/i],
      ['member_id', /\bmember\s+id\b/i],
    ],
  },
  {
    category: 'education_record',
    context: [
      ['grade', /\b(?:grade|gpa|transcript)\b/i],
      ['iep', /\b(?:iep|individualized\s+education\s+program)\b/i],
      ['discipline', /\bdisciplin(?:e|ary)\b|\bsuspension\b/i],
      ['attendance', /\battendance\s+record\b/i],
    ],
    identity: [
      ['student', /\bstudent\b/i],
      ['student_id', /\bstudent\s+(?:id|number)\b/i],
      ['parent_guardian', /\b(?:parent|guardian)\b/i],
    ],
  },
  {
    category: 'broker_dealer_record',
    context: [
      ['trade', /\btrade\s+(?:confirmation|order|allocation)\b/i],
      ['securities_account', /\bsecurities\s+account\b|\bbrokerage\s+account\b/i],
      ['investment_recommendation', /\binvestment\s+recommendation\b|\bsuitability\b/i],
      ['registered_representative', /\bregistered\s+representative\b|\bbroker-dealer\b/i],
    ],
    identity: [
      ['account', /\baccount\s+(?:number|holder|id)\b/i],
      ['customer', /\bcustomer\b|\bclient\b/i],
      ['security', /\b(?:cusip|ticker|security)\b/i],
    ],
  },
];

export function classifyRegulatedContent(
  fields: Record<string, string | null | undefined>,
): RegulatedContentFinding[] {
  const findings: RegulatedContentFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const rule of RULES) {
      const context = rule.context.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
      const identity = rule.identity.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
      // Require a regulated-record term plus an identity/context join. This
      // avoids classifying generic words such as "grade" or "trade" alone.
      if (context.length && identity.length) {
        findings.push({ category: rule.category, field, signals: [...context, ...identity].sort() });
      }
    }
  }
  return findings;
}

const REQUIRED_MODE: Record<RegulatedContentCategory, RegulatedWorkloadMode> = {
  phi: 'hipaa',
  education_record: 'ferpa',
  broker_dealer_record: 'sec_finra',
};

export async function unauthorizedRegulatedFindings(
  customerId: string,
  findings: RegulatedContentFinding[],
): Promise<Array<RegulatedContentFinding & { required_mode: RegulatedWorkloadMode }>> {
  if (!findings.length) return [];
  const modes = [...new Set(findings.map((finding) => REQUIRED_MODE[finding.category]))];
  const active = await db.selectFrom('regulated_workload_posture').select('mode')
    .where('customer_id', '=', customerId).where('mode', 'in', modes).where('status', '=', 'active').execute();
  const activeSet = new Set(active.map((row) => row.mode));
  return findings.filter((finding) => !activeSet.has(REQUIRED_MODE[finding.category]))
    .map((finding) => ({ ...finding, required_mode: REQUIRED_MODE[finding.category] }));
}

export function summarizeRegulatedFindings(findings: RegulatedContentFinding[]) {
  return {
    categories: [...new Set(findings.map((finding) => finding.category))].sort(),
    fields: [...new Set(findings.map((finding) => finding.field))].sort(),
    signals: [...new Set(findings.flatMap((finding) => finding.signals))].sort(),
  };
}
