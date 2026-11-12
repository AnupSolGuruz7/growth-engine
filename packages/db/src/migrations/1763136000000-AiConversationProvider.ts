import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ask AI histories are stored in the provider's own message format. Remember which provider wrote
 * them so a conversation continued after switching providers starts a fresh model history
 * (the visible transcript is kept).
 */
export class AiConversationProvider1763136000000 implements MigrationInterface {
  name = 'AiConversationProvider1763136000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE ai_conversations ADD COLUMN provider text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE ai_conversations DROP COLUMN provider`);
  }
}
