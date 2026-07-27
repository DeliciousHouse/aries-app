import assert from 'node:assert/strict';
import test from 'node:test';

import { handleDeleteSocialContentPost } from '../app/api/social-content/jobs/[jobId]/posts/[postId]/route';
import { handlePatchScheduleSocialContentPost } from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';
import {
  autoDefaultCadenceSchedulePosts,
  autoSchedulePosts,
} from '../backend/marketing/auto-schedule';
import { upsertScheduledPost } from '../backend/social-content/scheduled-posts';

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

type Gate = {
  entered: Promise<void>;
  signalEntered: () => void;
  release: Promise<void>;
  signalRelease: () => void;
};

function makeGate(): Gate {
  let signalEntered!: () => void;
  let signalRelease!: () => void;
  return {
    entered: new Promise<void>((resolve) => { signalEntered = resolve; }),
    signalEntered,
    release: new Promise<void>((resolve) => { signalRelease = resolve; }),
    signalRelease,
  };
}

class ScheduleDeleteRaceDb {
  readonly parentLock = new Mutex();
  parentExists = true;
  scheduledExists = false;
  deleteGate = makeGate();
  scheduleCanonicalAttempted = makeGate();

  async connect(role: 'schedule' | 'delete'): Promise<RaceClient> {
    return new RaceClient(this, role);
  }
}

class RaceClient {
  private releaseParent: (() => void) | null = null;
  private stagedParentDelete = false;
  private stagedScheduleDelete = false;
  private stagedScheduleCreate = false;

  constructor(
    private readonly db: ScheduleDeleteRaceDb,
    private readonly role: 'schedule' | 'delete',
  ) {}

  async query(sql: string, params: unknown[] = []) {
    const text = sql.trim();
    if (text === 'BEGIN') return { rows: [], rowCount: 0 };
    if (text === 'ROLLBACK') {
      this.releaseParent?.();
      this.releaseParent = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      if (this.stagedScheduleCreate) this.db.scheduledExists = true;
      if (this.stagedScheduleDelete) this.db.scheduledExists = false;
      if (this.stagedParentDelete) this.db.parentExists = false;
      this.releaseParent?.();
      this.releaseParent = null;
      return { rows: [], rowCount: 0 };
    }
    if (/FROM posts[\s\S]*FOR UPDATE/i.test(text)) {
      const firstCanonicalLock = this.releaseParent === null;
      if (firstCanonicalLock && this.role === 'schedule') {
        this.db.scheduleCanonicalAttempted.signalEntered();
      }
      if (firstCanonicalLock) this.releaseParent = await this.db.parentLock.acquire();
      if (this.role === 'delete' && firstCanonicalLock) {
        this.db.deleteGate.signalEntered();
        await this.db.deleteGate.release;
      }
      if (!this.db.parentExists) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: Number(params[0]),
          tenant_id: Number(params[1]),
          surface: 'feed',
          media_type: 'image',
          width_px: null,
          height_px: null,
          duration_seconds: null,
          style_dimension: null,
          style_value: null,
        }],
        rowCount: 1,
      };
    }
    if (/FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(text)) {
      return this.db.scheduledExists
        ? { rows: [{ id: 71, dispatch_status: 'pending', has_terminal_dispatch_evidence: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.startsWith('WITH existing AS')) {
      this.stagedScheduleCreate = true;
      return {
        rows: [{
          id: 71,
          post_id: Number(params[0]),
          tenant_id: Number(params[1]),
          scheduled_for: String(params[2]),
          target_platforms: params[3],
          updated_at: '2026-07-26T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (text.startsWith('DELETE FROM scheduled_posts')) {
      const existed = this.db.scheduledExists;
      this.stagedScheduleDelete = existed;
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (text.startsWith('DELETE FROM posts')) {
      this.stagedParentDelete = this.db.parentExists;
      return { rows: [], rowCount: this.db.parentExists ? 1 : 0 };
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

test('canonical delete racing first schedule creation leaves no orphan or claimable schedule', async () => {
  const db = new ScheduleDeleteRaceDb();
  const deleteQueryable = {
    query: async () => { throw new Error('delete must use a dedicated transaction client'); },
    connect: () => db.connect('delete'),
  };
  const scheduleQueryable = {
    query: async () => { throw new Error('schedule must use a dedicated transaction client'); },
    connect: () => db.connect('schedule'),
  };

  const deleting = handleDeleteSocialContentPost('job-race', '42', {
    tenantContextLoader: tenantLoader(),
    queryable: deleteQueryable as never,
    publishApprovalResolver: async () => true,
  });
  await db.deleteGate.entered;

  const scheduling = handlePatchScheduleSocialContentPost(
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
      queryable: scheduleQueryable as never,
      publishApprovalResolver: async () => true,
    },
  );

  await db.scheduleCanonicalAttempted.entered;
  db.deleteGate.signalRelease();
  const [deleteResponse, scheduleResponse] = await Promise.all([deleting, scheduling]);

  assert.equal(deleteResponse.status, 200);
  assert.equal(scheduleResponse.status, 404, 'schedule rechecks canonical existence after acquiring the parent lock');
  assert.equal(db.parentExists, false);
  assert.equal(db.scheduledExists, false, 'no orphan schedule can survive canonical deletion');
});

class BackgroundScheduleDeleteRaceDb {
  readonly canonicalLock = new Mutex();
  parentExists = true;
  scheduledExists = false;
  deleteObservedNoSchedule = makeGate();
  backgroundCanonicalAttempted = makeGate();

  async connect(role: 'background' | 'delete'): Promise<BackgroundRaceClient> {
    return new BackgroundRaceClient(this, role);
  }

  async query(sql: string, params: unknown[] = []) {
    const text = sql.trim();
    if (text.startsWith('WITH existing AS')) {
      this.scheduledExists = true;
      return {
        rows: [{
          id: 81,
          post_id: Number(params[0]),
          tenant_id: Number(params[1]),
          scheduled_for: String(params[2]),
          target_platforms: params[3],
          updated_at: '2026-07-26T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    throw new Error(`background writer bypassed its dedicated transaction: ${text}`);
  }
}

class BackgroundRaceClient {
  private releaseCanonical: (() => void) | null = null;
  private stagedParentDelete = false;
  private stagedScheduleCreate = false;

  constructor(
    private readonly db: BackgroundScheduleDeleteRaceDb,
    private readonly role: 'background' | 'delete',
  ) {}

  async query(sql: string, params: unknown[] = []) {
    const text = sql.trim();
    if (text === 'BEGIN') return { rows: [], rowCount: 0 };
    if (text === 'ROLLBACK') {
      this.releaseCanonical?.();
      this.releaseCanonical = null;
      this.stagedParentDelete = false;
      this.stagedScheduleCreate = false;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      if (this.stagedScheduleCreate) this.db.scheduledExists = true;
      if (this.stagedParentDelete) this.db.parentExists = false;
      this.releaseCanonical?.();
      this.releaseCanonical = null;
      return { rows: [], rowCount: 0 };
    }
    if (/FROM posts[\s\S]*FOR UPDATE/i.test(text)) {
      if (!this.releaseCanonical && this.role === 'background') {
        this.db.backgroundCanonicalAttempted.signalEntered();
      }
      if (!this.releaseCanonical) this.releaseCanonical = await this.db.canonicalLock.acquire();
      if (!this.db.parentExists) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: Number(params[0]),
          tenant_id: Number(params[1]),
          style_dimension: null,
          style_value: null,
        }],
        rowCount: 1,
      };
    }
    if (/FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(text)) {
      const scheduledExistedAtStatementStart = this.db.scheduledExists;
      if (this.role === 'delete' && !scheduledExistedAtStatementStart) {
        this.db.deleteObservedNoSchedule.signalEntered();
        await this.db.deleteObservedNoSchedule.release;
      }
      return scheduledExistedAtStatementStart
        ? { rows: [{ id: 81, dispatch_status: 'pending', has_terminal_dispatch_evidence: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.startsWith('WITH existing AS')) {
      this.stagedScheduleCreate = true;
      return {
        rows: [{
          id: 81,
          post_id: Number(params[0]),
          tenant_id: Number(params[1]),
          scheduled_for: String(params[2]),
          target_platforms: params[3],
          updated_at: '2026-07-26T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (text.startsWith('DELETE FROM posts')) {
      this.stagedParentDelete = this.db.parentExists;
      return { rows: [], rowCount: this.db.parentExists ? 1 : 0 };
    }
    throw new Error(`unexpected SQL (${this.role}): ${text}`);
  }

  release(): void {}
}

type BackgroundWriterResult = { scheduled: number; errors: unknown[] };
type BackgroundQueryable = NonNullable<Parameters<typeof autoSchedulePosts>[0]['queryable']>;

const backgroundWriters: Array<{
  name: string;
  run: (queryable: BackgroundQueryable) => Promise<BackgroundWriterResult>;
}> = [
  {
    name: 'recommended-day auto-schedule',
    run: (queryable) => autoSchedulePosts({
      jobId: 'job-background-race',
      tenantId: 15,
      tenantTimezone: 'UTC',
      campaignStart: new Date('2026-07-27T00:00:00.000Z'),
      campaignEnd: new Date('2026-07-30T23:59:59.000Z'),
      rows: [{ postId: 42, platform: 'facebook', recommendedDay: 'Monday' }],
      queryable,
      now: new Date('2026-07-26T00:00:00.000Z'),
    }),
  },
  {
    name: 'default-cadence auto-schedule',
    run: (queryable) => autoDefaultCadenceSchedulePosts({
      jobId: 'job-background-race',
      tenantId: 15,
      tenantTimezone: 'UTC',
      campaignStart: new Date('2026-07-27T00:00:00.000Z'),
      campaignEnd: new Date('2026-07-30T23:59:59.000Z'),
      rows: [{ postId: 42, platform: 'facebook', ordinal: 1 }],
      queryable,
      now: new Date('2026-07-26T00:00:00.000Z'),
    }),
  },
  {
    name: 'direct scheduled-post helper',
    run: async (queryable) => {
      try {
        await upsertScheduledPost(queryable, {
          tenantId: 15,
          postId: 42,
          scheduledFor: new Date('2026-07-27T12:00:00.000Z'),
          platforms: ['facebook'],
        });
        return { scheduled: 1, errors: [] };
      } catch (error) {
        return { scheduled: 0, errors: [error] };
      }
    },
  },
];

for (const writer of backgroundWriters) {
  test(`${writer.name} reaches canonical lock before delete release and cannot create an orphan`, async () => {
    const db = new BackgroundScheduleDeleteRaceDb();
    const deleteQueryable = {
      query: async () => { throw new Error('delete must use a dedicated transaction client'); },
      connect: () => db.connect('delete'),
    };
    const backgroundQueryable = {
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      connect: () => db.connect('background'),
    };

    const deleting = handleDeleteSocialContentPost('job-background-race', '42', {
      tenantContextLoader: tenantLoader(),
      queryable: deleteQueryable as never,
      publishApprovalResolver: async () => true,
    });
    await db.deleteObservedNoSchedule.entered;

    const scheduling = writer.run(backgroundQueryable as unknown as BackgroundQueryable);
    await db.backgroundCanonicalAttempted.entered;
    db.deleteObservedNoSchedule.signalRelease();
    const [deleteResponse, scheduleResult] = await Promise.all([deleting, scheduling]);

    assert.equal(deleteResponse.status, 200);
    assert.equal(scheduleResult.scheduled, 0, 'the writer rechecks canonical existence under lock');
    assert.equal(scheduleResult.errors.length, 1);
    assert.equal(db.parentExists, false);
    assert.equal(db.scheduledExists, false, 'no orphan schedule can survive canonical deletion');
  });
}
