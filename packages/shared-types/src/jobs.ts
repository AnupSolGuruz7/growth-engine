/** BullMQ queue + job names shared by the API (producer) and worker (consumer). */
export const PROCESSING_QUEUE = 'growthos-processing';
export const DEAD_LETTER_QUEUE = 'growthos-dead-letter';

export const JOBS = {
  /** Drain dirty visitor-days (sessionise) and dirty site-days (rollups). */
  PROCESS: 'process',
  /** Create upcoming monthly event partitions. */
  PARTITIONS: 'partitions',
} as const;

/** Fixed job id so bursts of ingestion collapse into one pending processing job. */
export const PROCESS_JOB_ID = 'process-pending';
