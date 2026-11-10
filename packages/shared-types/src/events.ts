import { z } from 'zod';

/** Current wire schema version sent by the SDK. */
export const SCHEMA_VERSION = 1;

export const MAX_BATCH_EVENTS = 50;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_PROPERTIES = 25;

export const CONSENT_STATES = ['granted', 'denied', 'pending'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const DEVICE_CATEGORIES = ['desktop', 'mobile', 'tablet'] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

/** Event names: letters, digits, `_ . : -`; must start with a letter, digit or underscore. */
export const EVENT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

const optStr = (max: number) => z.string().max(max).optional().nullable();

export const propertyValueSchema = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);

export const propertiesSchema = z
  .record(z.string().min(1).max(64), propertyValueSchema)
  .refine((o) => Object.keys(o).length <= MAX_PROPERTIES, {
    message: `at most ${MAX_PROPERTIES} properties`,
  });

export const incomingEventSchema = z.object({
  event_id: z.string().uuid(),
  event_name: z.string().regex(EVENT_NAME_RE, 'invalid event_name'),
  event_time: z.string().datetime({ offset: true }),
  /** Persistent pseudonymous id. Only honoured when consent_state = granted. */
  visitor_id: optStr(64),
  /** Client session id. Only honoured when consent_state = granted. */
  session_id: optStr(64),
  /**
   * Random id held in page memory only (never written to storage). Lets the server group the
   * events of one cookieless page lifetime / SPA visit without any persistent identifier.
   */
  ephemeral_id: optStr(64),
  page_url: optStr(2048),
  page_path: optStr(1024),
  page_title: optStr(512),
  referrer: optStr(2048),
  utm_source: optStr(256),
  utm_medium: optStr(256),
  utm_campaign: optStr(256),
  utm_term: optStr(256),
  utm_content: optStr(256),
  device_category: z.enum(DEVICE_CATEGORIES).optional().nullable(),
  consent_state: z.enum(CONSENT_STATES).optional().default('pending'),
  properties: propertiesSchema.optional().default({}),
});
export type IncomingEvent = z.input<typeof incomingEventSchema>;
export type ParsedEvent = z.output<typeof incomingEventSchema>;

/**
 * The envelope is validated first; events are then validated one by one so a single bad event
 * is reported in `rejected[]` instead of failing the whole batch.
 */
export const batchEnvelopeSchema = z.object({
  site_id: z.string().min(1).max(64),
  schema_version: z.literal(SCHEMA_VERSION),
  sdk_version: z.string().max(32).optional(),
  sent_at: z.string().datetime({ offset: true }).optional(),
  /** Set by the SDK when navigator.webdriver is true (headless/automation marker). */
  automation: z.boolean().optional(),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
});
export type BatchEnvelope = z.infer<typeof batchEnvelopeSchema>;

export type BatchRequest = Omit<BatchEnvelope, 'events'> & { events: IncomingEvent[] };

export type RejectReason =
  | 'invalid_schema'
  | 'event_time_out_of_range';

export interface RejectedEvent {
  event_id: string | null;
  index: number;
  reason: RejectReason;
  detail?: string;
}

export interface BatchResponse {
  accepted: number;
  duplicates: number;
  rejected: RejectedEvent[];
  /** Number of events dropped because the request looked like a bot. Bots are never stored. */
  dropped_bots: number;
}

/** Turns zod issues into one short human-readable line. */
export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
