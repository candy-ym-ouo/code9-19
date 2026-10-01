import { Router } from 'express';
import { lifecycleBackfillSchema, type LifecyclePhase } from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { requireInspiration } from '../services/inspirations.js';
import {
  backfillTransition,
  getEvents,
  queryLibraryEvents,
  toLifecycleEventDto,
  verifyChain,
} from '../services/lifecycle.js';

export const lifecycleRouter = Router();
lifecycleRouter.use(authenticate());

/**
 * 单卡生命周期审计轨迹。
 * 默认按落账顺序（seq）返回——这是"先后不可篡改"的权威视角；
 * 传 ?order=event 则按业务发生时间排序（补录条目会出现在它实际发生的位置，
 * 并带 backfilled=true 标记，两个时间都可见）。
 */
lifecycleRouter.get(
  '/inspirations/:id/lifecycle',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    let items = getEvents(row.id).map(toLifecycleEventDto);
    if (req.query.order === 'event') {
      items = items.sort((a, b) => (a.eventAt < b.eventAt ? -1 : a.eventAt > b.eventAt ? 1 : a.seq - b.seq));
    }
    const verify = verifyChain({ libraryId: ctx.libraryId, inspirationId: row.id });
    ok(res, { items, integrity: verify, currentPhase: items.at(-1)?.phase ?? null });
  }),
);

/**
 * 全库审计回溯：支持按业务时间区间与责任人过滤。
 *   GET /api/lifecycle/events?from=...&to=...&actorId=...&phase=lit,scheduled
 *       &backfilled=false&sort=event|recorded
 */
lifecycleRouter.get(
  '/lifecycle/events',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const items = queryLibraryEvents(ctx.libraryId, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      actorId: req.query.actorId as string | undefined,
      phase: req.query.phase as string | undefined,
      backfilled:
        req.query.backfilled === undefined ? undefined : String(req.query.backfilled) === 'true',
      sort: String(req.query.sort ?? 'event') === 'recorded' ? 'recorded' : 'event',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }).map(toLifecycleEventDto);
    ok(res, { items });
  }),
);

/**
 * 事后补录一次历史转变（如断网期间记录的"那天已经排过期/布过光"）。
 * 只追加、不改当前状态、不能补终态矛盾；eventAt 必须早于链尾发生时间。
 */
lifecycleRouter.post(
  '/inspirations/:id/lifecycle/backfill',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const input = lifecycleBackfillSchema.parse(req.body);
    const event = backfillTransition({
      inspiration: row,
      phase: input.phase as LifecyclePhase,
      reason: input.reason,
      eventAt: input.eventAt,
      detail: input.detail ?? null,
    });
    ok(res, { item: toLifecycleEventDto(event) }, 201);
  }),
);

/** 哈希链完整性校验：单卡或全库；返回第一条断链位置与原因 */
lifecycleRouter.get(
  '/lifecycle/verify',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const inspirationId = (req.query.inspirationId as string | undefined) || undefined;
    if (inspirationId) requireInspiration(inspirationId, ctx.libraryId);
    const result = verifyChain({ libraryId: ctx.libraryId, inspirationId });
    ok(res, { ...result, scope: inspirationId ? 'inspiration' : 'library' });
  }),
);
