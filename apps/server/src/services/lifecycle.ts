import { createHash } from 'node:crypto';
import {
  canReach,
  canTransitionLifecycle,
  LIFECYCLE_PHASE_LABEL,
  LifecycleEventKind,
  phaseOfStatus,
  type LifecyclePhase,
} from '@flil/shared';
import type { InspirationStatus, LifecycleEventDto } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, rowToBool } from '../db.js';
import { errors } from '../http/errors.js';
import { currentActor, type LifecycleActor } from '../http/actorContext.js';
import type { InspirationRow } from './serialization.js';

/** 未来时间容差：客户端时钟略微超前可接受，超出则拒绝 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface LifecycleEventRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  seq: number;
  kind: 'genesis' | 'transition';
  phase: LifecyclePhase;
  from_status: InspirationStatus | null;
  to_status: InspirationStatus;
  reason: string;
  detail: string | null;
  actor_id: string | null;
  actor_name: string;
  actor_role: 'owner' | 'member' | 'system';
  event_at: string;
  recorded_at: string;
  backfilled: number;
  prev_hash: string | null;
  hash: string;
}

/**
 * 哈希链载荷：字段固定、JSON 键序固定，保证任何时间、任何机器复算结果一致。
 * 链按 (inspiration_id, seq) 组织——补录只追加更大的 seq，因此永远只是"接链尾"，
 * 不需要像全局链那样在历史中间插链。
 */
function computeHash(input: {
  seq: number;
  inspirationId: string;
  kind: string;
  phase: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  detail: string | null;
  actorId: string | null;
  actorName: string;
  actorRole: string;
  eventAt: string;
  recordedAt: string;
  backfilled: boolean;
  prevHash: string | null;
}): string {
  const canonical = JSON.stringify({
    inspiration_id: input.inspirationId,
    seq: input.seq,
    kind: input.kind,
    phase: input.phase,
    from_status: input.fromStatus,
    to_status: input.toStatus,
    reason: input.reason,
    detail: input.detail,
    actor_id: input.actorId,
    actor_name: input.actorName,
    actor_role: input.actorRole,
    event_at: input.eventAt,
    recorded_at: input.recordedAt,
    backfilled: input.backfilled ? 1 : 0,
    prev_hash: input.prevHash,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function loadTail(inspirationId: string): LifecycleEventRow | undefined {
  return getDb()
    .prepare('SELECT * FROM inspiration_lifecycle_event WHERE inspiration_id = ? ORDER BY seq DESC LIMIT 1')
    .get(inspirationId) as LifecycleEventRow | undefined;
}

export function getEvents(inspirationId: string): LifecycleEventRow[] {
  return getDb()
    .prepare('SELECT * FROM inspiration_lifecycle_event WHERE inspiration_id = ? ORDER BY seq ASC')
    .all(inspirationId) as LifecycleEventRow[];
}

/**
 * 追加一条审计事件（唯一的写入口）。
 * 同事务内取 seq 最大值 + 1，配合 better-sqlite3 的同步事务，并发也不会错号。
 */
function appendEvent(params: {
  inspirationId: string;
  libraryId: string;
  kind: 'genesis' | 'transition';
  phase: LifecyclePhase;
  fromStatus: InspirationStatus | null;
  toStatus: InspirationStatus;
  reason: string;
  detail?: Record<string, unknown> | null;
  actor?: LifecycleActor;
  eventAt?: string;
  backfilled?: boolean;
}): LifecycleEventRow {
  const db = getDb();
  const actor = params.actor ?? currentActor();
  const recordedAt = nowIso();
  const eventAt = params.eventAt ?? recordedAt;
  const detailJson = params.detail === undefined || params.detail === null ? null : JSON.stringify(params.detail);

  const insert = db.transaction((): LifecycleEventRow => {
    const max = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM inspiration_lifecycle_event WHERE inspiration_id = ?')
      .get(params.inspirationId) as { n: number };
    const seq = max.n + 1;
    const prev = max.n === 0 ? null : loadTail(params.inspirationId)?.hash ?? null;
    const hash = computeHash({
      seq,
      inspirationId: params.inspirationId,
      kind: params.kind,
      phase: params.phase,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      reason: params.reason,
      detail: detailJson,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      eventAt,
      recordedAt,
      backfilled: params.backfilled === true,
      prevHash: prev,
    });
    const id = newId();
    db.prepare(
      `INSERT INTO inspiration_lifecycle_event
         (id, library_id, inspiration_id, seq, kind, phase, from_status, to_status, reason, detail,
          actor_id, actor_name, actor_role, event_at, recorded_at, backfilled, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      params.libraryId,
      params.inspirationId,
      seq,
      params.kind,
      params.phase,
      params.fromStatus,
      params.toStatus,
      params.reason,
      detailJson,
      actor.id,
      actor.name,
      actor.role,
      eventAt,
      recordedAt,
      params.backfilled === true ? 1 : 0,
      prev,
      hash,
    );
    return db
      .prepare('SELECT * FROM inspiration_lifecycle_event WHERE id = ?')
      .get(id) as LifecycleEventRow;
  });
  return insert.immediate() as LifecycleEventRow;
}

/**
 * 状态变化的统一记账点。
 * 只在"五阶段之间发生跳变"时落事件；草稿期内的自动细状态
 * （draft/tagging/timing_missing）与 shot 不产生审计噪声。
 */
export function recordStatusChange(
  row: { id: string; library_id: string; status: InspirationStatus },
  nextStatus: InspirationStatus,
  reason: string,
  detail?: Record<string, unknown> | null,
  opts: { eventAt?: string; actor?: LifecycleActor } = {},
): LifecycleEventRow | null {
  const fromPhase = phaseOfStatus(row.status);
  const toPhase = phaseOfStatus(nextStatus);
  if (fromPhase === toPhase) return null;
  return appendEvent({
    inspirationId: row.id,
    libraryId: row.library_id,
    kind: LifecycleEventKind.transition,
    phase: toPhase,
    fromStatus: row.status,
    toStatus: nextStatus,
    reason,
    detail,
    eventAt: opts.eventAt,
    actor: opts.actor,
  });
}

/** 新建灵感卡的生命周期起点（genesis / draft） */
export function recordGenesis(inspirationId: string, libraryId: string): LifecycleEventRow {
  return appendEvent({
    inspirationId,
    libraryId,
    kind: LifecycleEventKind.genesis,
    phase: 'draft',
    fromStatus: null,
    toStatus: 'draft',
    reason: 'created',
    detail: null,
  });
}

/**
 * 为迁移前已存在的历史卡片补一条基线（迁移脚本调用，system 责任人）。
 * 以"当前所处阶段"作为可追溯起点，并显式标注 bootstrapped / 补录。
 */
export function bootstrapExistingCard(row: InspirationRow): LifecycleEventRow | null {
  const db = getDb();
  const existing = db
    .prepare('SELECT 1 AS x FROM inspiration_lifecycle_event WHERE inspiration_id = ?')
    .get(row.id);
  if (existing) return null;
  const phase = phaseOfStatus(row.status);
  return appendEvent({
    inspirationId: row.id,
    libraryId: row.library_id,
    kind: LifecycleEventKind.genesis,
    phase,
    fromStatus: null,
    toStatus: row.status,
    reason: 'bootstrapped',
    detail: { note: '迁移时为历史卡片补建的生命周期基线', statusAtBootstrap: row.status },
    actor: { id: null, name: 'system', role: 'system' },
    eventAt: row.created_at,
    backfilled: true,
  });
}

/** 迁移后统一补基线（幂等），返回补建条数 */
export function bootstrapAllExisting(): number {
  const rows = getDb()
    .prepare('SELECT * FROM inspiration WHERE deleted_at IS NULL')
    .all() as InspirationRow[];
  let n = 0;
  const run = getDb().transaction(() => {
    for (const row of rows) {
      if (bootstrapExistingCard(row)) n += 1;
    }
  });
  run();
  return n;
}

/**
 * 事后补录：只追加审计，不改卡片当前状态（"补录不得篡改先后"）。
 * 规则：
 *   1. eventAt 必须是过去时间（允许 5 分钟时钟超前容差）；
 *   2. eventAt 必须早于现有链尾的发生时间——否则应当直接走真实转变接口；
 *   3. 补的阶段必须与卡片当前阶段对得上（活动卡不能补出终态；终态卡不能补另一个终态）；
 *   4. 不允许补 genesis（链已经有起点）。
 */
export function backfillTransition(params: {
  inspiration: InspirationRow;
  phase: LifecyclePhase;
  reason: string;
  eventAt: string;
  detail?: Record<string, unknown> | null;
}): LifecycleEventRow {
  const { inspiration } = params;
  const now = Date.now();
  const at = new Date(params.eventAt).getTime();
  if (Number.isNaN(at)) throw errors.badRequest('eventAt 不是合法时间');
  if (at > now + FUTURE_SKEW_MS) throw errors.badRequest('补录时间不能是未来时间');

  const tail = loadTail(inspiration.id);
  if (!tail) throw errors.badRequest('该卡片还没有生命周期基线，无法补录');
  if (at >= new Date(tail.event_at).getTime()) {
    throw errors.badRequest(
      '补录时间必须早于上一条记录的发生时间；若事情刚发生，请直接使用阶段转变接口',
    );
  }
  if (!canReach(phaseOfStatus(inspiration.status), params.phase)) {
    throw errors.badRequest(
      `不能为当前处于「${LIFECYCLE_PHASE_LABEL[phaseOfStatus(inspiration.status)]}」的卡片补录「${LIFECYCLE_PHASE_LABEL[params.phase]}」阶段`,
    );
  }

  // 落账时把细状态映射成该阶段的代表状态，仅用于审计展示，不写回 inspiration 表
  const representativeStatus: Record<LifecyclePhase, InspirationStatus> = {
    draft: 'draft',
    lit: 'ready',
    scheduled: 'scheduled',
    archived: 'archived',
    dropped: 'dropped',
  };
  return appendEvent({
    inspirationId: inspiration.id,
    libraryId: inspiration.library_id,
    kind: LifecycleEventKind.transition,
    phase: params.phase,
    fromStatus: tail.to_status,
    toStatus: representativeStatus[params.phase],
    reason: params.reason,
    detail: params.detail ?? null,
    eventAt: params.eventAt,
    backfilled: true,
  });
}

/** 显式人工转变（归档 / 放弃 / 活动阶段间拨弄）——返回应当写入卡片的目标细状态 */
export function targetStatusForPhase(
  current: InspirationStatus,
  phase: LifecyclePhase,
): InspirationStatus {
  const currentPhase = phaseOfStatus(current);
  if (!canTransitionLifecycle(currentPhase, phase)) {
    throw errors.badRequest(
      `不允许从「${LIFECYCLE_PHASE_LABEL[currentPhase]}」转变到「${LIFECYCLE_PHASE_LABEL[phase]}」（终态不可离开）`,
    );
  }
  const map: Record<Exclude<LifecyclePhase, 'archived' | 'dropped'> | 'archived' | 'dropped', InspirationStatus> = {
    draft: 'draft',
    lit: 'ready',
    scheduled: 'scheduled',
    archived: 'archived',
    dropped: 'dropped',
  };
  return map[phase];
}

// ------------------------------------------------------------------ 查询

export interface AuditQuery {
  from?: string;
  to?: string;
  actorId?: string;
  phase?: string;
  backfilled?: boolean;
  sort?: 'event' | 'recorded';
  limit?: number;
}

export function queryLibraryEvents(libraryId: string, q: AuditQuery = {}): LifecycleEventRow[] {
  const where = ['library_id = ?'];
  const args: (string | number)[] = [libraryId];
  if (q.from) {
    where.push('event_at >= ?');
    args.push(q.from);
  }
  if (q.to) {
    where.push('event_at <= ?');
    args.push(q.to);
  }
  if (q.actorId) {
    where.push('actor_id = ?');
    args.push(q.actorId);
  }
  if (q.phase) {
    const phases = q.phase.split(',').filter(Boolean);
    where.push(`phase IN (${phases.map(() => '?').join(',')})`);
    args.push(...phases);
  }
  if (q.backfilled !== undefined) {
    where.push('backfilled = ?');
    args.push(q.backfilled ? 1 : 0);
  }
  // 时间回溯默认按业务发生时间；"落账先后"视角按 recorded_at
  const orderColumn = q.sort === 'recorded' ? 'recorded_at' : 'event_at';
  const limit = Math.min(500, Math.max(1, q.limit ?? 100));
  return getDb()
    .prepare(
      `SELECT * FROM inspiration_lifecycle_event WHERE ${where.join(' AND ')}
       ORDER BY ${orderColumn} DESC, seq DESC LIMIT ?`,
    )
    .all(...args, limit) as LifecycleEventRow[];
}

export function toLifecycleEventDto(row: LifecycleEventRow): LifecycleEventDto {
  return {
    id: row.id,
    inspirationId: row.inspiration_id,
    seq: row.seq,
    kind: row.kind,
    phase: row.phase,
    phaseLabel: LIFECYCLE_PHASE_LABEL[row.phase],
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    detail: row.detail ? parseJson<Record<string, unknown> | null>(row.detail, null) : null,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    eventAt: row.event_at,
    recordedAt: row.recorded_at,
    backfilled: rowToBool(row.backfilled),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * 完整性校验：重算哈希链。
 * 范围可以是单张卡片或整个库（库校验时按灵感分组、组内按 seq 复算）。
 */
export function verifyChain(scope: { libraryId: string; inspirationId?: string }): {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
  reason: string | null;
} {
  const db = getDb();
  const rows = (
    scope.inspirationId
      ? db
          .prepare(
            'SELECT * FROM inspiration_lifecycle_event WHERE library_id = ? AND inspiration_id = ? ORDER BY inspiration_id, seq ASC',
          )
          .all(scope.libraryId, scope.inspirationId)
      : db
          .prepare(
            'SELECT * FROM inspiration_lifecycle_event WHERE library_id = ? ORDER BY inspiration_id, seq ASC',
          )
          .all(scope.libraryId)
  ) as LifecycleEventRow[];

  let prevByInspiration = new Map<string, string | null>();
  let seqByInspiration = new Map<string, number>();
  for (const row of rows) {
    const expectedSeq = (seqByInspiration.get(row.inspiration_id) ?? 0) + 1;
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: `序号不连续：期望 seq=${expectedSeq}，实际 seq=${row.seq}`,
      };
    }
    seqByInspiration.set(row.inspiration_id, expectedSeq);

    const expectedPrev = prevByInspiration.get(row.inspiration_id) ?? null;
    if ((row.prev_hash ?? null) !== expectedPrev) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'prev_hash 断链（记录被插入或替换过）',
      };
    }
    const expectedHash = computeHash({
      seq: row.seq,
      inspirationId: row.inspiration_id,
      kind: row.kind,
      phase: row.phase,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      detail: row.detail,
      actorId: row.actor_id,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      eventAt: row.event_at,
      recordedAt: row.recorded_at,
      backfilled: rowToBool(row.backfilled),
      prevHash: row.prev_hash,
    });
    if (row.hash !== expectedHash) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'hash 不匹配（记录内容被篡改）',
      };
    }
    prevByInspiration.set(row.inspiration_id, row.hash);
  }
  return { ok: true, checked: rows.length, brokenAt: null, reason: null };
}
