import { Router } from 'express';
import { z } from 'zod';
import { backfillLifecycleSchema, LifecycleSource, type InspirationStatus } from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { actorOf, ctxOf } from '../http/context.js';
import { requireInspiration } from '../services/inspirations.js';
import {
  backfillLifecycle,
  listLifecycleForInspiration,
  listLifecycleForLibrary,
  type LifecycleFilter,
} from '../services/lifecycle.js';

export const lifecycleRouter = Router();
lifecycleRouter.use(authenticate());

const filterSchema = z.object({
  actorId: z.string().min(1).optional(),
  source: z.enum([LifecycleSource.user, LifecycleSource.system, LifecycleSource.backfill]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});

function parseFilter(query: unknown): LifecycleFilter {
  const parsed = filterSchema.parse(query ?? {});
  return parsed;
}

/** 单卡生命周期时间线：创建 → 每次状态转变，按追加序回放 */
lifecycleRouter.get(
  '/inspirations/:id/lifecycle',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const items = listLifecycleForInspiration(row.id, parseFilter(req.query));
    ok(res, { items });
  }),
);

/** 全库回溯：按时间（occurredAt）与责任人过滤 */
lifecycleRouter.get(
  '/lifecycle',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const filter = parseFilter(req.query);
    const inspirationId = req.query.inspirationId ? String(req.query.inspirationId) : undefined;
    if (inspirationId) requireInspiration(inspirationId, ctx.libraryId);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(req.query.size ?? 50)));
    const { items, total } = listLifecycleForLibrary(ctx.libraryId, {
      ...filter,
      inspirationId,
      page,
      size,
    });
    ok(res, { items, total, page, size });
  }),
);

/**
 * 补录一条历史转变（文档化约束见 services/lifecycle.ts）：
 * 只追加台账、不改当前状态；occurredAt 必须是过去；必须填写原因。
 */
lifecycleRouter.post(
  '/inspirations/:id/lifecycle/backfill',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const input = backfillLifecycleSchema.parse(req.body) as {
      toStatus: InspirationStatus;
      fromStatus?: InspirationStatus | null;
      occurredAt: string;
      reason: string;
    };
    const item = backfillLifecycle({
      libraryId: ctx.libraryId,
      inspirationId: row.id,
      inspirationCreatedAt: row.created_at,
      toStatus: input.toStatus,
      fromStatus: input.fromStatus ?? undefined,
      occurredAt: input.occurredAt,
      reason: input.reason,
      actor: actorOf(req),
    });
    ok(res, { item }, 201);
  }),
);
