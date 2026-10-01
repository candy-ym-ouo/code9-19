import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import type { InspirationRow } from './serialization.js';
import { recordGenesis, recordStatusChange } from './lifecycle.js';

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[\s/|·、，,。.]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || `t-${Buffer.from(name).toString('hex').slice(0, 8)}`;
}

export function requireInspiration(id: string, libraryId: string): InspirationRow {
  const row = getDb()
    .prepare('SELECT * FROM inspiration WHERE id = ? AND deleted_at IS NULL')
    .get(id) as InspirationRow | undefined;
  if (!row) throw errors.notFound('灵感卡');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  return row;
}

export function touch(id: string): void {
  getDb().prepare('UPDATE inspiration SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

export function tagCountOf(inspirationId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE inspiration_id = ?')
    .get(inspirationId) as { n: number };
  return r.n;
}

export function hasTiming(inspirationId: string): boolean {
  const r = getDb().prepare('SELECT 1 AS x FROM timing WHERE inspiration_id = ?').get(inspirationId);
  return Boolean(r);
}

/**
 * 状态机（文档 6.1）：所有状态变更都从这里走，保证没有"断头状态"。
 * 终态（archived / dropped）不会被自动改写。
 *
 * 五阶段（草稿/布光/排期/归档/放弃）之间的跳变会同步落一条不可变审计事件；
 * 草稿期内的自动细状态（tagging / timing_missing 等）只反映工作进度，不产生审计噪声。
 */
export function syncStatus(inspirationId: string, reasonOverride?: string): InspirationRow['status'] {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(inspirationId) as
    | InspirationRow
    | undefined;
  if (!row) throw errors.notFound('灵感卡');
  if (row.status === 'archived' || row.status === 'dropped') return row.status;

  const activePlans = db
    .prepare('SELECT COUNT(*) AS n FROM shoot_plan WHERE inspiration_id = ? AND status != ?')
    .get(inspirationId, 'cancelled') as { n: number };
  const cancelledPlans = db
    .prepare("SELECT COUNT(*) AS n FROM shoot_plan WHERE inspiration_id = ? AND status = 'cancelled'")
    .get(inspirationId) as { n: number };
  const hasPlan = activePlans.n > 0;
  const hasResult = Boolean(
    db.prepare('SELECT 1 AS x FROM shoot_result WHERE inspiration_id = ?').get(inspirationId),
  );
  const assetCount = (
    db.prepare('SELECT COUNT(*) AS n FROM asset WHERE inspiration_id = ?').get(inspirationId) as { n: number }
  ).n;

  let status: InspirationRow['status'];
  if (hasResult) status = 'shot';
  else if (hasPlan) status = 'scheduled';
  else if (!hasTiming(inspirationId)) {
    status = tagCountOf(inspirationId) > 0 || assetCount > 0 ? 'timing_missing' : 'draft';
  } else if (tagCountOf(inspirationId) === 0) {
    status = 'tagging';
  } else {
    status = 'ready';
  }

  if (status !== row.status) {
    const ts = nowIso();
    db.prepare('UPDATE inspiration SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, inspirationId);
    // 审计：仅五阶段跳变落事件；排期退回布光时若存在已取消的计划，归因为 plan_cancelled
    let reason = reasonOverride;
    if (!reason) {
      if (status === 'scheduled') reason = 'plan_created';
      else if (cancelledPlans.n > 0) reason = 'plan_cancelled';
      else reason = status === 'ready' ? 'ready' : 'manual';
    }
    recordStatusChange(row, status, reason);
  }
  return status;
}

export function createInspiration(params: {
  libraryId: string;
  title: string;
  note?: string | null;
  seasonTags?: number[];
}): string {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO inspiration (id, library_id, title, note, status, season_tags, hit_count, partial_count,
       miss_count, hit_rate, created_at, updated_at)
     VALUES (?,?,?,?, 'draft', ?, 0,0,0,0, ?, ?)`,
  ).run(id, params.libraryId, params.title, params.note ?? null, toJson(params.seasonTags ?? []), ts, ts);
  // 生命周期起点：草稿 genesis
  recordGenesis(id, params.libraryId);
  reindexFts(id);
  return id;
}

export function addTags(
  inspirationId: string,
  tagIds: string[],
  source: 'manual' | 'bulk' | 'album_gap' | 'suggested' = 'manual',
): number {
  const db = getDb();
  const ts = nowIso();
  let added = 0;
  const stmt = db.prepare(
    `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,?,?)
     ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
  );
  const run = db.transaction(() => {
    for (const tagId of tagIds) {
      const res = stmt.run(inspirationId, tagId, source, ts);
      if (res.changes > 0) {
        added += 1;
        db.prepare('UPDATE tag SET usage_count = usage_count + 1 WHERE id = ?').run(tagId);
      }
    }
  });
  run();
  if (added) {
    touch(inspirationId);
    reindexFts(inspirationId);
  }
  syncStatus(inspirationId);
  return added;
}

export function removeTags(inspirationId: string, tagIds: string[]): number {
  const db = getDb();
  let removed = 0;
  const run = db.transaction(() => {
    for (const tagId of tagIds) {
      const res = db
        .prepare('DELETE FROM inspiration_tag WHERE inspiration_id = ? AND tag_id = ?')
        .run(inspirationId, tagId);
      if (res.changes > 0) {
        removed += 1;
        db.prepare('UPDATE tag SET usage_count = MAX(0, usage_count - 1) WHERE id = ?').run(tagId);
      }
    }
  });
  run();
  if (removed) {
    touch(inspirationId);
    reindexFts(inspirationId);
  }
  syncStatus(inspirationId);
  return removed;
}

export function setSpot(inspirationId: string, spotId: string | null): void {
  getDb()
    .prepare('UPDATE inspiration SET spot_id = ?, updated_at = ? WHERE id = ?')
    .run(spotId, nowIso(), inspirationId);
  syncStatus(inspirationId);
}

export function archiveInspiration(id: string, reason: string | null): void {
  const db = getDb();
  const before = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(id) as InspirationRow | undefined;
  if (!before) throw errors.notFound('灵感卡');
  const ts = nowIso();
  db.prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?').run(
    'archived',
    reason,
    ts,
    id,
  );
  recordStatusChange(before, 'archived', 'manual', { archivedReason: reason });
}

export function dropInspiration(id: string, reason: string): void {
  const db = getDb();
  const before = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(id) as InspirationRow | undefined;
  if (!before) throw errors.notFound('灵感卡');
  const ts = nowIso();
  db.prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?').run(
    'dropped',
    reason,
    ts,
    id,
  );
  recordStatusChange(before, 'dropped', 'manual', { dropReason: reason });
}

/** 合并重复卡：标签与图片并入 keep，来源卡进终态 dropped（文档 9.2） */
export function mergeInspirations(keepId: string, mergeIds: string[], reason = 'merged'): void {
  const db = getDb();
  const run = db.transaction(() => {
    for (const mergeId of mergeIds) {
      if (mergeId === keepId) continue;
      const before = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(mergeId) as
        | InspirationRow
        | undefined;
      if (!before) continue;
      const tags = db
        .prepare('SELECT tag_id FROM inspiration_tag WHERE inspiration_id = ?')
        .all(mergeId) as { tag_id: string }[];
      for (const t of tags) {
        db.prepare(
          `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
           ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
        ).run(keepId, t.tag_id, nowIso());
      }
      db.prepare('UPDATE asset SET inspiration_id = ? WHERE inspiration_id = ?').run(keepId, mergeId);
      db.prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?').run(
        'dropped',
        reason,
        nowIso(),
        mergeId,
      );
      recordStatusChange(before, 'dropped', 'merged', { mergedInto: keepId, reason });
      reindexFts(mergeId);
    }
    reindexFts(keepId);
  });
  run();
  syncStatus(keepId);
}

/** 维护 FTS 索引（检索用，文档 15.1） */
export function reindexFts(inspirationId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT id, title, note, spot_id FROM inspiration WHERE id = ?').get(inspirationId) as
    | { id: string; title: string; note: string | null; spot_id: string | null }
    | undefined;
  db.prepare('DELETE FROM inspiration_fts WHERE inspiration_id = ?').run(inspirationId);
  if (!row) return;

  let placeText = '';
  if (row.spot_id) {
    const p = db
      .prepare(
        `SELECT pl.name AS place_name, pl.city, pl.district, s.access_note, s.best_time_note
         FROM spot s JOIN place pl ON pl.id = s.place_id WHERE s.id = ?`,
      )
      .get(row.spot_id) as
      | {
          place_name: string;
          city: string | null;
          district: string | null;
          access_note: string | null;
          best_time_note: string | null;
        }
      | undefined;
    if (p) {
      placeText = [p.place_name, p.city, p.district, p.access_note, p.best_time_note].filter(Boolean).join(' ');
    }
  }
  const tags = db
    .prepare(
      'SELECT t.name FROM inspiration_tag it JOIN tag t ON t.id = it.tag_id WHERE it.inspiration_id = ?',
    )
    .all(inspirationId) as { name: string }[];

  db.prepare('INSERT INTO inspiration_fts (inspiration_id, title, note, place, tags) VALUES (?,?,?,?,?)').run(
    inspirationId,
    row.title,
    row.note ?? '',
    placeText,
    tags.map((t) => t.name).join(' '),
  );
}

export function reindexAll(libraryId: string): number {
  const rows = getDb()
    .prepare('SELECT id FROM inspiration WHERE library_id = ? AND deleted_at IS NULL')
    .all(libraryId) as { id: string }[];
  const run = getDb().transaction(() => {
    for (const r of rows) reindexFts(r.id);
  });
  run();
  return rows.length;
}

export function seasonTagsOf(row: InspirationRow): number[] {
  return parseJson<number[]>(row.season_tags, []);
}
