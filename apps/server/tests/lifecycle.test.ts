import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

let app: Express;
let token = '';
let tmpDir = '';
let cardId = '';
let planId = '';
let ownerId = '';
let tagId = '';

interface EventItem {
  id: string;
  seq: number;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  actorName: string;
  source: 'user' | 'system' | 'backfill';
  reason: string | null;
  occurredAt: string;
  recordedAt: string;
}

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function lifecycle(): Promise<EventItem[]> {
  const res = await call('get', `/api/inspirations/${cardId}/lifecycle`);
  expect(res.status).toBe(200);
  return res.body.items as EventItem[];
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-lifecycle-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('L1 每次转变都进台账，且责任人可辨', () => {
  it('未登录不能读台账', async () => {
    const res = await request(app).get('/api/inspirations/whatever/lifecycle');
    expect(res.status).toBe(401);
  });

  it('注册并建卡：台账第一条是"创建 → 草稿"，责任人是本人', async () => {
    const res = await call('post', '/api/auth/register', {
      email: 'owner@lifecycle.local',
      password: 'password123',
      displayName: '台账所有者',
    });
    expect(res.status).toBe(201);
    token = res.body.token;

    const tags = await call('get', '/api/tags');
    const flat = (tags.body.items as { children?: { id: string }[] }[]).flatMap((g) => g.children ?? []);
    tagId = flat[0].id;

    const created = await call('post', '/api/inspirations', { title: '台账测试卡' });
    expect(created.status).toBe(201);
    cardId = created.body.id;

    const items = await lifecycle();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seq: 1,
      fromStatus: null,
      toStatus: 'draft',
      source: 'user',
      actorName: '台账所有者',
    });
    ownerId = items[0].actorId!;
    expect(ownerId).toBeTruthy();
  });

  it('打标 → timing_missing；备齐条件 → ready，转变连续编号', async () => {
    await call('post', '/api/inspirations/bulk-tag', { ids: [cardId], addTagIds: [tagId] });

    const place = await call('post', '/api/places', { name: '台账地点', city: '上海' });
    const spot = await call('post', '/api/spots', {
      placeId: place.body.id,
      lat: 31.2,
      lng: 121.4,
      cameraBearing: 90,
    });
    await call('post', `/api/inspirations/${cardId}/spot`, { spotId: spot.body.id });
    await call('put', `/api/inspirations/${cardId}/timing`, {
      timeAnchor: 'sunset_minus',
      anchorOffsetMin: 40,
      elevationRange: [-4, 10],
      azimuthRange: null,
      azimuthTolerance: 15,
      windowToleranceMin: 12,
      weatherProfile: {},
      seasonWindow: null,
      notes: null,
    });

    const items = await lifecycle();
    expect(items.map((e) => e.toStatus)).toEqual(['draft', 'timing_missing', 'ready']);
    expect(items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(items.every((e) => e.actorId === ownerId)).toBe(true);
  });

  it('接单 → scheduled；回填 → shot，责任人都落账', async () => {
    await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    const windows = await call('get', `/api/inspirations/${cardId}/windows`);
    const usable = windows.body.items.find((w: { verdict: string }) => w.verdict !== 'bad');
    const plan = await call('post', '/api/plans', { windowId: usable.id, commuteMin: 30 });
    expect(plan.status).toBe(201);
    planId = plan.body.id;

    let items = await lifecycle();
    expect(items[items.length - 1].toStatus).toBe('scheduled');

    const fill = await call('post', `/api/plans/${planId}/result`, { hitLevel: 'hit', missReasons: [] });
    expect(fill.status).toBe(201);
    items = await lifecycle();
    expect(items[items.length - 1]).toMatchObject({ fromStatus: 'scheduled', toStatus: 'shot', actorId: ownerId });
  });

  it('手动调整状态也会留痕', async () => {
    const res = await call('patch', `/api/inspirations/${cardId}`, { status: 'ready' });
    expect(res.status).toBe(200);
    const items = await lifecycle();
    const manual = items.find((e) => e.reason === '手动调整状态');
    expect(manual).toBeTruthy();
    expect(manual!.fromStatus).toBe('shot');
    expect(manual!.toStatus).toBe('ready');
  });

  it('归档带原因落账', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/archive`, { reason: '已出片，存档' });
    expect(res.status).toBe(200);
    const items = await lifecycle();
    const last = items[items.length - 1];
    expect(last.toStatus).toBe('archived');
    expect(last.reason).toBe('已出片，存档');
  });
});

describe('L2 补录：只追加、不改现状、不篡改先后', () => {
  it('补录过去时间成功：source=backfill，排在台账末尾，当前状态不变', async () => {
    const before = await lifecycle();
    const creation = before[0];
    const res = await call('post', `/api/inspirations/${cardId}/lifecycle/backfill`, {
      toStatus: 'tagging',
      occurredAt: creation.occurredAt, // 与创建同时刻：推断前置状态应为 draft
      reason: '当时在外面勘景，回来补登',
    });
    expect(res.status).toBe(201);
    expect(res.body.item.source).toBe('backfill');
    expect(res.body.item.fromStatus).toBe('draft');
    expect(res.body.item.seq).toBe(before[before.length - 1].seq + 1);
    expect(res.body.item.recordedAt >= res.body.item.occurredAt).toBe(true);

    const detail = await call('get', `/api/inspirations/${cardId}`);
    expect(detail.body.item.status).toBe('archived'); // 补录不改现状

    const after = await lifecycle();
    const last = after[after.length - 1];
    expect(last.source).toBe('backfill');
    // 追加序不被业务时间打乱：补录记录 occurredAt 最早，seq 却最大
    expect(last.seq).toBe(Math.max(...after.map((e) => e.seq)));
    expect(last.occurredAt < after[after.length - 2].occurredAt).toBe(true);
    expect(after.map((e) => e.seq)).toEqual([...Array(after.length).keys()].map((i) => i + 1));
  });

  it('补录未来时间被拒', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/lifecycle/backfill`, {
      toStatus: 'ready',
      occurredAt: new Date(Date.now() + 3600_000).toISOString(),
      reason: '穿越测试',
    });
    expect(res.status).toBe(400);
  });

  it('补录早于建卡时间被拒', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/lifecycle/backfill`, {
      toStatus: 'ready',
      occurredAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
      reason: '史前测试',
    });
    expect(res.status).toBe(400);
  });

  it('补录必须填原因', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/lifecycle/backfill`, {
      toStatus: 'ready',
      occurredAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('补录之后正常操作继续追加，序号不回填', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/drop`, { reason: '场地已拆除' });
    expect(res.status).toBe(200);
    const items = await lifecycle();
    expect(items[items.length - 1].toStatus).toBe('dropped');
    expect(items.map((e) => e.seq)).toEqual([...Array(items.length).keys()].map((i) => i + 1));
  });
});

describe('L3 按时间与责任人回溯', () => {
  it('全库查询：按责任人过滤', async () => {
    const all = await call('get', '/api/lifecycle?size=100');
    expect(all.body.total).toBeGreaterThan(0);

    const mine = await call('get', `/api/lifecycle?actorId=${ownerId}&size=100`);
    expect(mine.body.total).toBe(all.body.total); // 本测试库只有一个操作人
    for (const e of mine.body.items as EventItem[]) expect(e.actorId).toBe(ownerId);

    const nobody = await call('get', '/api/lifecycle?actorId=no-such-user&size=100');
    expect(nobody.body.total).toBe(0);
  });

  it('全库查询：按业务时间过滤', async () => {
    const future = await call('get', `/api/lifecycle?from=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`);
    expect(future.body.total).toBe(0);

    const past = await call('get', `/api/lifecycle?to=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`);
    expect(past.body.total).toBe(0);

    const ranged = await call(
      'get',
      `/api/lifecycle?from=${encodeURIComponent(new Date(Date.now() - 86400_000).toISOString())}&size=100`,
    );
    expect(ranged.body.total).toBeGreaterThan(0);
  });

  it('全库查询：按来源过滤，补录记录可单独捞出', async () => {
    const res = await call('get', '/api/lifecycle?source=backfill&size=100');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].source).toBe('backfill');
    expect(res.body.items[0].inspirationTitle).toBe('台账测试卡');
  });

  it('单卡时间线：按责任人过滤', async () => {
    const res = await call('get', `/api/inspirations/${cardId}/lifecycle?actorId=no-such-user`);
    expect(res.body.items).toHaveLength(0);
  });
});
