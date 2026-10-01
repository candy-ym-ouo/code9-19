-- 灵感生命周期审计（草稿 / 布光 / 排期 / 归档 / 放弃）
--
-- 设计底线（对应需求："补录不得篡改先后"）：
--   1. 只追加：BEFORE UPDATE / BEFORE DELETE 触发器直接 ABORT，任何改写都落不了库；
--   2. 双时间：event_at 是业务发生时间（补录可早），recorded_at 是服务器落账时间（永不改）；
--   3. 不插队：seq 按 (inspiration, 落账顺序) 单调递增，补录也只拿更大的 seq；
--   4. 防篡改：prev_hash + sha256 哈希链，改任意一行，其后的链全部对不上。

CREATE TABLE IF NOT EXISTS inspiration_lifecycle_event (
  id              TEXT PRIMARY KEY,
  library_id      TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  inspiration_id  TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  -- 同灵感内按落账顺序的单调序号（从 1 开始）
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('genesis','transition')),
  phase           TEXT NOT NULL CHECK (phase IN ('draft','lit','scheduled','archived','dropped')),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  detail          TEXT,
  actor_id        TEXT,
  actor_name      TEXT NOT NULL,
  actor_role      TEXT NOT NULL CHECK (actor_role IN ('owner','member','system')),
  event_at        TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  backfilled      INTEGER NOT NULL DEFAULT 0,
  prev_hash       TEXT,
  hash            TEXT NOT NULL,
  UNIQUE (inspiration_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_library_time
  ON inspiration_lifecycle_event(library_id, event_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_library_recorded
  ON inspiration_lifecycle_event(library_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_actor
  ON inspiration_lifecycle_event(library_id, actor_id, event_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_insp_seq
  ON inspiration_lifecycle_event(inspiration_id, seq);

-- 只追加：禁止更新与删除（含"修复"、"清理"——要更正只能再追加一条说明）
CREATE TRIGGER IF NOT EXISTS trg_lifecycle_no_update
BEFORE UPDATE ON inspiration_lifecycle_event
BEGIN
  SELECT RAISE(ABORT, 'lifecycle_event is append-only: UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_lifecycle_no_delete
BEFORE DELETE ON inspiration_lifecycle_event
BEGIN
  SELECT RAISE(ABORT, 'lifecycle_event is append-only: DELETE forbidden');
END;
