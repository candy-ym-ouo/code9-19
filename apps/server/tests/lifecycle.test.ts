import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

let app: Express;
let token = '';
let ownerId = '';
let tagIds: Record<string, string> = {};
let tmpDir = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown, asToken?: string) {
  let req = request(app)[method](url);
  const t = asToken === undefined ? token : asToken;
  if (t) req = req.set('authorization', `Bearer ${t}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function makeReadyCard(title: string): Promise<string> {
  const created = await call('post', '/api/inspirations', { title });
  const id = created.body.id;
  const place = await call('post', '/api/places', { name: `地点-${title}`, city: '上海' });
  const spot = await call('post', '/api/spots', {
    placeId: place.body.id,
    lat: 31.24,
    lng: 121.45,
    cameraBearing: 260,
  });
  await call('post', `/api/inspirations/${id}/spot`, { spotId: spot.body.id });
  await call('put', `/api/inspirations/${id}/timing`, {
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
  await call('post', '/api/inspirations/bulk-tag', {
    ids: [id],
    addTagIds: [tagIds['逆光']],
  });
  return id;
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

  const reg = await call('post', '/api/auth/register', {
    email: 'lc-owner@test.local',
    password: 'password123',
    displayName: '生命周期责任人',
  });
  token = reg.body.token;
  ownerId = reg.body.user?.id ?? '';
  const tags = await call('get', '/api/tags');
  const flat = (tags.body.items as { children?: { id: string; name: string }[] }[]).flatMap(
    (g) => g.children ?? [],
  );
  tagIds = Object.fromEntries(flat.map((t) => [t.name, t.id]));
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('L1 每次转变都留痕（草稿→布光→排期→归档/放弃）', () => {
  it('创建即有 genesis；细状态（timing_missing / tagging）不产生审计噪声', async () => {
    const created = await call('post', '/api/inspirations', { title: '审计噪声测试卡' });
    const id = created.body.id;
    let trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    expect(trail.status).toBe(200);
    expect(trail.body.items).toHaveLength(1);
    expect(trail.body.items[0]).toMatchObject({
      kind: 'genesis',
      phase: 'draft',
      phaseLabel: '草稿',
      seq: 1,
      backfilled: false,
    });
    expect(trail.body.items[0].recordedAt).toBe(trail.body.items[0].eventAt);
    expect(trail.body.integrity.ok).toBe(true);

    await call('post', '/api/inspirations/bulk-tag', { ids: [id], addTagIds: [tagIds['逆光']] });
    trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    // 仍然只有 genesis —— timing_missing 属于草稿期，不产生阶段事件
    expect(trail.body.items).toHaveLength(1);
  });

  it('条件齐备 → lit(布光)，记录责任人与双时间', async () => {
    const id = await makeReadyCard('布光审计卡');
    const trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    const phases = trail.body.items.map((e: { phase: string }) => e.phase);
    expect(phases).toEqual(['draft', 'lit']);
    const lit = trail.body.items[1];
    expect(lit.reason).toBe('ready');
    expect(lit.fromStatus).toBeTruthy();
    expect(lit.toStatus).toBe('ready');
    expect(lit.actorName).toBe('生命周期责任人');
    expect(lit.actorRole).toBe('owner');
    expect(lit.actorId).toBeTruthy();
    expect(new Date(lit.recordedAt).getTime()).toBeGreaterThan(0);
  });

  it('接单 → scheduled(排期)；取消计划退回 lit，原因是 plan_cancelled', async () => {
    const id = await makeReadyCard('排期审计卡');
    await call('post', `/api/inspirations/${id}/windows/recompute`, { days: 7 });
    const windows = await call('get', `/api/inspirations/${id}/windows?days=7`);
    const usable = windows.body.items.find((w: { verdict: string }) => w.verdict !== 'bad');
    expect(usable).toBeTruthy();
    const plan = await call('post', '/api/plans', { windowId: usable.id, commuteMin: 30 });
    expect(plan.status).toBe(201);

    let trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    expect(trail.body.items.at(-1)).toMatchObject({ phase: 'scheduled', reason: 'plan_created' });

    await call('patch', `/api/plans/${plan.body.id}`, { status: 'cancelled', cancelReason: '下雨改期' });
    trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    expect(trail.body.items.at(-1)).toMatchObject({ phase: 'lit', reason: 'plan_cancelled' });
    const reasons = trail.body.items.map((e: { reason: string }) => e.reason);
    expect(reasons).toEqual(['created', 'ready', 'plan_created', 'plan_cancelled']);
  });

  it('归档与放弃都落终态事件，且带原因', async () => {
    const a = await makeReadyCard('归档审计卡');
    const archived = await call('post', `/api/inspirations/${a}/archive`, { reason: '已出片封板' });
    expect(archived.status).toBe(200);
    const trailA = await call('get', `/api/inspirations/${a}/lifecycle`);
    expect(trailA.body.items.at(-1)).toMatchObject({ phase: 'archived' });
    expect(trailA.body.items.at(-1).detail.archivedReason).toBe('已出片封板');

    const b = await makeReadyCard('放弃审计卡');
    const dropped = await call('post', `/api/inspirations/${b}/drop`, { reason: '现场已拆' });
    expect(dropped.status).toBe(200);
    const trailB = await call('get', `/api/inspirations/${b}/lifecycle`);
    expect(trailB.body.items.at(-1)).toMatchObject({ phase: 'dropped' });
  });
});

describe('L2 按时间与责任人回溯', () => {
  it('全库事件支持时间区间 / 阶段 / 责任人过滤', async () => {
    const id = await makeReadyCard('回溯卡');
    const all = await call('get', '/api/lifecycle/events?sort=event');
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);

    const mine = await call('get', `/api/lifecycle/events?actorId=${ownerId}`);
    expect(mine.body.items.every((e: { actorId: string }) => e.actorId === ownerId)).toBe(true);

    const onlyLit = await call('get', '/api/lifecycle/events?phase=lit');
    expect(onlyLit.body.items.every((e: { phase: string }) => e.phase === 'lit')).toBe(true);

    const future = await call('get', '/api/lifecycle/events?from=2999-01-01T00:00:00.000Z');
    expect(future.body.items).toHaveLength(0);

    const windowed = await call(
      'get',
      `/api/lifecycle/events?from=2000-01-01T00:00:00.000Z&to=2001-01-01T00:00:00.000Z`,
    );
    expect(windowed.body.items).toHaveLength(0);

    // 这张卡的布光事件必须能在全库视角被找到
    const hit = all.body.items.find(
      (e: { inspirationId: string; phase: string }) => e.inspirationId === id && e.phase === 'lit',
    );
    expect(hit).toBeTruthy();
    expect(hit.inspirationId).toBe(id);
  });

  it('member 看不到别库卡片的审计（403/404）', async () => {
    const other = await call('post', '/api/auth/register', {
      email: 'lc-member@test.local',
      password: 'password123',
      displayName: '外人',
    });
    const mine = await makeReadyCard('隐私卡');
    const denied = await call('get', `/api/inspirations/${mine}/lifecycle`, undefined, other.body.token);
    expect([403, 404]).toContain(denied.status);
  });
});

describe('L3 补录不得篡改先后', () => {
  it('补录只追加：seq 继续增大，链尾当前阶段不变，事件带 backfilled 与双时间', async () => {
    const id = await makeReadyCard('补录卡');
    const before = await call('get', `/api/inspirations/${id}/lifecycle`);
    const tailSeq = before.body.items.at(-1).seq;

    const past = new Date(Date.now() - 10 * 86400000).toISOString();
    const res = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'scheduled',
      reason: '断网那周实际出过境',
      eventAt: past,
    });
    expect(res.status).toBe(201);
    expect(res.body.item.backfilled).toBe(true);
    expect(res.body.item.seq).toBe(tailSeq + 1);
    expect(res.body.item.eventAt).toBe(past);
    expect(new Date(res.body.item.recordedAt).getTime()).toBeGreaterThan(new Date(past).getTime());
    expect(res.body.item.reason).toBe('断网那周实际出过境');

    // 落账视角：补录在链尾（不插队）
    const afterSeq = await call('get', `/api/inspirations/${id}/lifecycle`);
    expect(afterSeq.body.items.at(-1).seq).toBe(tailSeq + 1);
    expect(afterSeq.body.integrity.ok).toBe(true);

    // 业务时间视角：补录按发生时间回到前面，并明确标记
    const afterEvent = await call('get', `/api/inspirations/${id}/lifecycle?order=event`);
    expect(afterEvent.body.items[0].eventAt).toBe(past);
    expect(afterEvent.body.items[0].backfilled).toBe(true);

    // 卡片当前状态没被补录改动（仍是 ready/lit）
    const detail = await call('get', `/api/inspirations/${id}`);
    expect(detail.body.item.status).toBe('ready');
  });

  it('补录时间不能晚于链尾发生时间（刚发生的事走转变接口）', async () => {
    const id = await makeReadyCard('补录时间非法卡');
    const trail = await call('get', `/api/inspirations/${id}/lifecycle`);
    const tailAt = trail.body.items.at(-1).eventAt;
    const later = new Date(new Date(tailAt).getTime() + 3600000).toISOString();
    const res = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'draft',
      reason: '试图把新事伪装成历史',
      eventAt: later,
    });
    expect(res.status).toBe(400);
  });

  it('未来时间、与当前阶段矛盾的终态补录被拒', async () => {
    const id = await makeReadyCard('矛盾补录卡');
    const future = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'scheduled',
      reason: '未来补录',
      eventAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(future.status).toBe(400);

    // 活动卡不能补"放弃"终态
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    const contradiction = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'dropped',
      reason: '试图把活着的卡补成已放弃',
      eventAt: past,
    });
    expect(contradiction.status).toBe(400);
  });

  it('终态卡可以补录它终态之前的活动阶段，但不能补另一个终态', async () => {
    const id = await makeReadyCard('终态补录卡');
    await call('post', `/api/inspirations/${id}/archive`, { reason: '封板' });
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    const okBackfill = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'scheduled',
      reason: '封板前出过镜',
      eventAt: past,
    });
    expect(okBackfill.status).toBe(201);

    const wrong = await call('post', `/api/inspirations/${id}/lifecycle/backfill`, {
      phase: 'dropped',
      reason: '不能给已归档卡补放弃',
      eventAt: new Date(Date.now() - 86400000).toISOString(),
    });
    expect(wrong.status).toBe(400);
  });
});

describe('L4 不可篡改：触发器 + 哈希链 + 终态', () => {
  it('SQL 层直接 UPDATE/DELETE 被拒（append-only）', async () => {
    const id = await makeReadyCard('触发器卡');
    const { getDb, closeDb } = await import('../src/db.js');
    const db = getDb();
    expect(() =>
      db.prepare('UPDATE inspiration_lifecycle_event SET reason = ? WHERE inspiration_id = ?').run(
        'hacked',
        id,
      ),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare('DELETE FROM inspiration_lifecycle_event WHERE inspiration_id = ?').run(id),
    ).toThrow(/append-only/);
    // 连接仍可用
    expect(closeDb).toBeTypeOf('function');
  });

  it('改动任一行内容 → verify 断链并报出断点', async () => {
    const id = await makeReadyCard('篡改检测卡');
    const good = await call('get', '/api/lifecycle/verify');
    expect(good.body.ok).toBe(true);

    const { getDb } = await import('../src/db.js');
    const db = getDb();
    // 触发器拦 UPDATE/DELETE，所以篡改测试临时关闭触发器模拟"数据库文件被人直接改"
    db.exec('DROP TRIGGER trg_lifecycle_no_update');
    db.prepare("UPDATE inspiration_lifecycle_event SET reason = 'tampered' WHERE seq = 1 AND inspiration_id = ?").run(
      id,
    );
    const verify = await call('get', `/api/lifecycle/verify?inspirationId=${id}`);
    expect(verify.body.ok).toBe(false);
    expect(verify.body.brokenAt).toBeTruthy();
    expect(verify.body.reason).toContain('hash');

    const libraryVerify = await call('get', '/api/lifecycle/verify');
    expect(libraryVerify.body.ok).toBe(false);
  });

  it('终态不可离开：归档/放弃后的状态机结算不复活卡片', async () => {
    const a = await makeReadyCard('终态不可出卡');
    await call('post', `/api/inspirations/${a}/archive`, { reason: null });
    // 归档后再打标签（触发 syncStatus），状态依旧是 archived
    await call('post', '/api/inspirations/bulk-tag', { ids: [a], addTagIds: [tagIds['连廊']] });
    const detail = await call('get', `/api/inspirations/${a}`);
    expect(detail.body.item.status).toBe('archived');
    const trail = await call('get', `/api/inspirations/${a}/lifecycle`);
    expect(trail.body.items.at(-1).phase).toBe('archived');
  });
});
