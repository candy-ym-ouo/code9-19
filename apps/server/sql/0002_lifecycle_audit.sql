-- 灵感生命周期审计（追加式台账，对应需求：记录每次状态转变，可按时间/责任人回溯，补录不得篡改先后）
--
-- 设计要点：
-- 1. seq 按灵感单调递增，只在插入时取 max(seq)+1 —— 台账顺序即追加顺序，永不重排；
-- 2. occurred_at 是业务发生时间（补录时可填过去），recorded_at 永远是落库当下；
--    补录记录的 occurred_at 再早，也只能带着新的 seq 排在台账末尾，无法插入历史中间；
-- 3. actor_name 冗余快照：人员改名、注销后，历史记录里的责任人仍可辨认；
-- 4. 本表只有 INSERT，没有任何 UPDATE / DELETE 入口。
CREATE TABLE IF NOT EXISTS inspiration_lifecycle_event (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  inspiration_id TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  from_status    TEXT CHECK (from_status IN ('draft','tagging','timing_missing','ready','scheduled','shot','archived','dropped')),
  to_status      TEXT NOT NULL
                 CHECK (to_status IN ('draft','tagging','timing_missing','ready','scheduled','shot','archived','dropped')),
  actor_id       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  actor_name     TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','system','backfill')),
  reason         TEXT,
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  UNIQUE (inspiration_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_insp ON inspiration_lifecycle_event(inspiration_id, seq);
CREATE INDEX IF NOT EXISTS idx_lifecycle_library_time ON inspiration_lifecycle_event(library_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_library_actor ON inspiration_lifecycle_event(library_id, actor_id, occurred_at);
