import assert from 'node:assert/strict';
import test from 'node:test';

import { handleDeleteScheduleSocialContentPost } from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';

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

class CancellationRaceDb {
  readonly ownerLock = new Mutex();
  owner: { id: number; status: string } | null = { id: 71, status: 'pending' };
  children = 2;
  cancelGate: Gate | null = null;
  claimGate: Gate | null = null;

  async connect(role: 'cancel' | 'claim' = 'cancel'): Promise<RaceClient> {
    return new RaceClient(this, role);
  }
}

class RaceClient {
  private releaseOwner: (() => void) | null = null;
  private stagedDelete = false;
  private stagedStatus: string | null = null;

  constructor(
    private readonly db: CancellationRaceDb,
    private readonly role: 'cancel' | 'claim',
  ) {}

  async query(sql: string, params: unknown[] = []) {
    const text = sql.trim();
    if (text === 'BEGIN') return { rows: [], rowCount: 0 };
    if (text === 'COMMIT') {
      if (this.stagedDelete) {
        this.db.owner = null;
        this.db.children = 0;
      } else if (this.stagedStatus && this.db.owner) {
        this.db.owner.status = this.stagedStatus;
      }
      this.releaseOwner?.();
      this.releaseOwner = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      this.releaseOwner?.();
      this.releaseOwner = null;
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('SELECT id, tenant_id FROM posts')) {
      return { rows: [{ id: Number(params[0]), tenant_id: Number(params[1]) }], rowCount: 1 };
    }
    if (/FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(text)) {
      this.releaseOwner = await this.db.ownerLock.acquire();
      const gate = this.role === 'cancel' ? this.db.cancelGate : this.db.claimGate;
      gate?.signalEntered();
      if (gate) await gate.release;
      if (!this.db.owner) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: this.db.owner.id, dispatch_status: this.db.owner.status }],
        rowCount: 1,
      };
    }
    if (text.startsWith('DELETE FROM scheduled_posts')) {
      if (!this.db.owner || this.db.owner.status !== 'pending') return { rows: [], rowCount: 0 };
      this.stagedDelete = true;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL (${this.role}): ${text}`);
  }

  stageClaim(): void {
    this.stagedStatus = 'in_flight';
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

async function claimScheduledRow(db: CancellationRaceDb): Promise<boolean> {
  const client = await db.connect('claim');
  await client.query('BEGIN');
  const row = await client.query(
    `SELECT id, dispatch_status
       FROM scheduled_posts
      WHERE post_id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [42, 15],
  );
  if (row.rows.length === 0) {
    await client.query('COMMIT');
    return false;
  }
  client.stageClaim();
  await client.query('COMMIT');
  return true;
}

function cancelOptions(db: CancellationRaceDb) {
  return {
    tenantContextLoader: tenantLoader(),
    queryable: {
      query: async () => { throw new Error('cancellation must use a dedicated transaction client'); },
      connect: () => db.connect('cancel'),
    },
    publishApprovalResolver: async () => true,
  };
}

test('cancel wins parent lock: owner and children disappear before claim can proceed', async () => {
  const db = new CancellationRaceDb();
  db.cancelGate = makeGate();

  const cancelling = handleDeleteScheduleSocialContentPost('job-abc', '42', cancelOptions(db));
  await db.cancelGate.entered;
  const claiming = claimScheduledRow(db);
  db.cancelGate.signalRelease();

  const [response, claimed] = await Promise.all([cancelling, claiming]);
  assert.equal(response.status, 200);
  assert.equal(claimed, false);
  assert.equal(db.owner, null);
  assert.equal(db.children, 0);
});

test('claim wins parent lock: cancellation conflicts and preserves owner plus children', async () => {
  const db = new CancellationRaceDb();
  db.claimGate = makeGate();

  const claiming = claimScheduledRow(db);
  await db.claimGate.entered;
  const cancelling = handleDeleteScheduleSocialContentPost('job-abc', '42', cancelOptions(db));
  db.claimGate.signalRelease();

  const [claimed, response] = await Promise.all([claiming, cancelling]);
  const body = (await response.json()) as { reason?: string };
  assert.equal(claimed, true);
  assert.equal(response.status, 409);
  assert.equal(body.reason, 'dispatch_in_flight');
  assert.deepEqual(db.owner, { id: 71, status: 'in_flight' });
  assert.equal(db.children, 2);
});
