import type { Channel } from '@growthos/shared-types';

// The dashboard only imports *types* from @growthos/shared-types (keeps zod out of the bundle).
export const CHANNEL_LABELS: Record<Channel, string> = {
  direct: 'Direct',
  organic_search: 'Organic search',
  paid: 'Paid',
  social: 'Social',
  email: 'Email',
  referral: 'Referral',
  ai_assistant: 'AI assistants',
  unknown: 'Unknown',
};
