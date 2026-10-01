import type { InspirationStatus, LifecycleEventDto, LifecycleSource } from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { errors } from '../http/errors.js';

/**
 * 责任人快照。id 为 null 表示系统动作（后台任务、状态机自动流转）；
 * name 冗余存显示名，人员改名或注销后历史仍可辨认。
 */
export interface LifecycleActor {
  id: string | null;
  name: string;
}

export const SYSTEM_ACTOR: LifecycleActor = { id: null, name: '系统' };

export interface LifecycleEventRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  seq: number;
  from_status: InspirationStatus | null;
  to_status: InspirationStatus;
  actor_id: string | null;
  actor_name: string;
  source: LifecycleSource;
  reason: string | null;
  occurred_at: string;
  recorded_at: string;
}

/**
 * 追加一条生命周期事件 —— 本模块唯一的写入入口。
 * seq 在插入时取 max(seq)+1：台账顺序即追加顺序，任何调用方都无法指定位置。
 * occurredAt 默认当下；只有补录（source='backfill'）才允许传过去时间。
 */
export function recordLifecycle(params: {
  libraryId: string;
  inspirationId: string;
  fromStatus: InspirationStatus | null;
  toStatus: InspirationStatus;
  actor?: LifecycleActor;
  source?: LifecycleSource;
  reason?: string | null;
  occurredAt?: string;
}): string {
  const db = getDb();
  const id = newId();
  const recordedAt = nowIso();
  const actor = params.actor ?? SYSTEM_ACTOR;
  const source = params.source ?? (actor.id ? 'user' : 'system');
  const occurredAt = params.occurredAt ?? recordedAt;
  if (source !== 'backfill' && occurredAt > recordedAt) {
    // 非补录事件不允许"发生在未来"——那说明调用方传错了时间
    throw errors.badRequest('事件时间不能晚于落库时间');
  }
  const { next } = db
    .prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM inspiration_lifecycle_event WHERE inspiration_id = ?',
    )
    .get(params.inspirationId) as { next: number };
  db.prepare(
    `INSERT INTO inspiration_lifecycle_event
       (id, library_id, inspiration_id, seq, from_status, to_status, actor_id, actor_name, source, reason, occurred_at, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    params.libraryId,
    params.inspirationId,
    next,
    params.fromStatus,
    params.toStatus,
    actor.id,
    actor.name,
    source,
    params.reason ?? null,
    occurredAt,
    recordedAt,
  );
  return id;
}

export function toLifecycleDto(row: LifecycleEventRow & { title?: string }): LifecycleEventDto {
  return {
    id: row.id,
    inspirationId: row.inspiration_id,
    ...(row.title !== undefined ? { inspirationTitle: row.title } : {}),
    seq: row.seq,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    actorName: row.actor_name,
    source: row.source,
    reason: row.reason,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

export interface LifecycleFilter {
  actorId?: string;
  source?: LifecycleSource;
  /** occurred_at 范围（业务发生时间） */
  from?: string;
  to?: string;
  /** 默认 asc：按追加序回放；desc 用于"先看最近" */
  order?: 'asc' | 'desc';
}

/** 单卡时间线：永远按 seq（追加序）排序，补录记录排在它实际落库的位置 */
export function listLifecycleForInspiration(
  inspirationId: string,
  filter: LifecycleFilter = {},
): LifecycleEventDto[] {
  const where = ['inspiration_id = ?'];
  const args: string[] = [inspirationId];
  pushFilter(where, args, filter);
  const rows = getDb()
    .prepare(
      `SELECT * FROM inspiration_lifecycle_event WHERE ${where.join(' AND ')}
       ORDER BY seq ${filter.order === 'desc' ? 'DESC' : 'ASC'}`,
    )
    .all(...args) as LifecycleEventRow[];
  return rows.map(toLifecycleDto);
}

/** 全库回溯：按时间（occurred_at）与责任人过滤，结果仍按追加序返回 */
export function listLifecycleForLibrary(
  libraryId: string,
  filter: LifecycleFilter & { inspirationId?: string; page?: number; size?: number },
): { items: LifecycleEventDto[]; total: number } {
  const where = ['e.library_id = ?'];
  const args: string[] = [libraryId];
  if (filter.inspirationId) {
    where.push('e.inspiration_id = ?');
    args.push(filter.inspirationId);
  }
  pushFilter(where, args, filter, 'e.');
  const page = Math.max(1, filter.page ?? 1);
  const size = Math.min(100, Math.max(1, filter.size ?? 50));
  const db = getDb();
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM inspiration_lifecycle_event e WHERE ${where.join(' AND ')}`)
      .get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT e.*, i.title AS title FROM inspiration_lifecycle_event e
       JOIN inspiration i ON i.id = e.inspiration_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.recorded_at ${filter.order === 'desc' ? 'DESC' : 'ASC'}, e.id
       LIMIT ? OFFSET ?`,
    )
    .all(...args, size, (page - 1) * size) as (LifecycleEventRow & { title: string })[];
  return { items: rows.map(toLifecycleDto), total };
}

function pushFilter(where: string[], args: string[], filter: LifecycleFilter, prefix = ''): void {
  if (filter.actorId) {
    where.push(`${prefix}actor_id = ?`);
    args.push(filter.actorId);
  }
  if (filter.source) {
    where.push(`${prefix}source = ?`);
    args.push(filter.source);
  }
  if (filter.from) {
    where.push(`${prefix}occurred_at >= ?`);
    args.push(filter.from);
  }
  if (filter.to) {
    where.push(`${prefix}occurred_at <= ?`);
    args.push(filter.to);
  }
}

/**
 * 补录一条历史转变 —— 只补台账，不改卡片当前状态。
 * 防篡改约束：
 *  - occurredAt 必须是过去（否则应走正常操作，而不是补录）；
 *  - occurredAt 不得早于卡片创建时间；
 *  - 必须填写补录原因；
 *  - 事件仍按追加序排在台账末尾（recorded_at = 当下），历史顺序不被插入。
 */
export function backfillLifecycle(params: {
  libraryId: string;
  inspirationId: string;
  inspirationCreatedAt: string;
  toStatus: InspirationStatus;
  fromStatus?: InspirationStatus | null;
  occurredAt: string;
  reason: string;
  actor: LifecycleActor;
}): LifecycleEventDto {
  const occurred = new Date(params.occurredAt);
  if (Number.isNaN(occurred.getTime())) throw errors.badRequest('occurredAt 不是合法时间');
  const now = nowIso();
  if (params.occurredAt >= now) {
    throw errors.badRequest('补录的发生时间必须早于当前时刻；当前发生的转变请直接操作');
  }
  if (params.occurredAt < params.inspirationCreatedAt) {
    throw errors.badRequest('补录的发生时间早于灵感卡创建时间，无法成立');
  }
  const fromStatus =
    params.fromStatus !== undefined ? params.fromStatus : inferFromStatus(params.inspirationId, params.occurredAt);
  const id = recordLifecycle({
    libraryId: params.libraryId,
    inspirationId: params.inspirationId,
    fromStatus,
    toStatus: params.toStatus,
    actor: params.actor,
    source: 'backfill',
    reason: params.reason,
    occurredAt: params.occurredAt,
  });
  const row = getDb()
    .prepare('SELECT * FROM inspiration_lifecycle_event WHERE id = ?')
    .get(id) as LifecycleEventRow;
  return toLifecycleDto(row);
}

/** 推断补录事件的前置状态：occurredAt 之前（按业务时间）最近一条事件到达的状态 */
function inferFromStatus(inspirationId: string, occurredAt: string): InspirationStatus | null {
  const row = getDb()
    .prepare(
      `SELECT to_status FROM inspiration_lifecycle_event
       WHERE inspiration_id = ? AND occurred_at <= ?
       ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    )
    .get(inspirationId, occurredAt) as { to_status: InspirationStatus } | undefined;
  return row?.to_status ?? null;
}
