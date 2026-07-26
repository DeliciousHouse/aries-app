import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleDeleteScheduleSocialContentPost,
  handlePatchScheduleSocialContentPost,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.locked) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve,
  };
}

class CancelRescheduleRaceDb {
  readonly parentLock = new Mutex();
  readonly scheduledLock = new Mutex();
  readonly rescheduleHasParent = deferred();
  readonly allowReschedule = deferred();
  scheduledExists = true;
  scheduledFor = '2026-07-26T12:00:00.000Z';

  connect(role: 'cancel' | 'reschedule'): Promise<RaceClient> {
    return Promise.resolve(new RaceClient(this, role));
  }
}

class RaceClient {
  private releaseParent: (() => void) | null = null;
  private releaseScheduled: (() => void) | null = null;
  private stagedScheduledExists: boolean | null = null;
  private stagedScheduledFor: string | null = null;

  constructor(
    private readonly db: CancelRescheduleRaceDb,
    private readonly role: 'cancel' | 'reschedule',
  ) {}

  private releaseLocks(): void {
    this.releaseScheduled?.();
    this.releaseScheduled = null;
    this.releaseParent?.();
    this.releaseParent = null;
  }

  async query(sql: string, params: unknown[] = []) {
    const text = sql.trim();
    if (text === 'BEGIN') return { rows: [], rowCount: 0 };
    if (text === 'ROLLBACK') {
      this.releaseLocks();
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      if (this.stagedScheduledExists !== null) this.db.scheduledExists = this.stagedScheduledExists;
      if (this.stagedScheduledFor !== null) this.db.scheduledFor = this.stagedScheduledFor;
      this.releaseLocks();
      return { rows: [], rowCount: 0 };
    }

    if (/FROM posts/i.test(text)) {
      if (/FOR UPDATE/i.test(text)) {
        this.releaseParent = await this.db.parentLock.acquire();
        if (this.role === 'reschedule') {
          this.db.rescheduleHasParent.resolve();
          await this.db.allowReschedule.promise;
        }
      }
      return {
        rows: [{
          id: Number(params[0]),
          tenant_id: Number(params[1]),
          surface: 'feed',
          media_type: 'image',
          width_px: null,
          height_px: null,
          duration_seconds: null,
        }],
        rowCount: 1,
      };
    }

    if (/FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(text) || text.startsWith('WITH existing AS')) {
      this.releaseScheduled = await this.db.scheduledLock.acquire();
      if (text.startsWith('WITH existing AS')) {
        this.stagedScheduledExists = true;
        this.stagedScheduledFor = String(params[2]);
        return {
          rows: [{
            id: 71,
            post_id: Number(params[0]),
            tenant_id: Number(params[1]),
            scheduled_for: String(params[2]),
            target_platforms: params[3],
            updated_at: '2026-07-26T13:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return this.db.scheduledExists
        ? {
            rows: [{ id: 71, dispatch_status: 'pending', has_terminal_dispatch_evidence: false }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }

    if (text.startsWith('DELETE FROM scheduled_posts')) {
      this.stagedScheduledExists = false;
      return { rows: [], rowCount: this.db.scheduledExists ? 1 : 0 };
    }

    throw new Error(`unexpected SQL (${this.role}): ${text}`);
  }

  release(): void {}
}

function tenantLoader() {
  return async () => ({
    userId: '1001',
    tenantId: '15',
    tenantSlug: 'tenant-15',
    role: 'tenant_admin' as const,
  });
}

test('cancel racing a reschedule serializes on the canonical post and leaves no schedule after successful cancellation', async () => {
  const db = new CancelRescheduleRaceDb();
  const rescheduleQueryable = {
    query: async () => { throw new Error('reschedule must use a transaction client'); },
    connect: () => db.connect('reschedule'),
  };
  const cancelQueryable = {
    query: async () => { throw new Error('cancel must use a transaction client'); },
    connect: () => db.connect('cancel'),
  };

  const rescheduling = handlePatchScheduleSocialContentPost(
    'job-race',
    '42',
    new Request('https://aries.example.test/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scheduled_at: '2026-07-27T12:00:00.000Z',
        platforms: ['facebook'],
      }),
    }),
    {
      tenantContextLoader: tenantLoader(),
      queryable: rescheduleQueryable as never,
      publishApprovalResolver: async () => true,
    },
  );
  await db.rescheduleHasParent.promise;

  const cancelling = handleDeleteScheduleSocialContentPost('job-race', '42', {
    tenantContextLoader: tenantLoader(),
    queryable: cancelQueryable as never,
    publishApprovalResolver: async () => true,
  });

  // Give cancellation a chance to race while reschedule owns the canonical lock.
  // A canonical-first DELETE blocks here; the rejected implementation instead
  // deletes the old child and lets reschedule recreate it after reporting success.
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.allowReschedule.resolve();

  const [rescheduleResponse, cancelResponse] = await Promise.all([rescheduling, cancelling]);
  assert.equal(rescheduleResponse.status, 200);
  assert.equal(cancelResponse.status, 200);
  assert.equal(
    db.scheduledExists,
    false,
    'a successful cancellation must delete the serialized reschedule winner rather than leave a surviving calendar row',
  );
});
