import { InspirationStatus } from './enums.js';

/**
 * 灵感生命周期五阶段（审计视角）。
 *
 * 底层状态机有 8 个细状态（见 InspirationStatus），审计记录按这五个
 * 粗阶段归档与展示；每次"阶段间转变"落一条不可变审计事件。
 *
 *   draft     草稿      —— 灵感刚记下，还没完成打标与条件
 *   lit       布光      —— 标签与光线条件齐备，卡片就绪（ready）
 *   scheduled 排期      —— 已有未取消的出行计划
 *   archived  归档      —— 终态，封板收藏
 *   dropped   放弃      —— 终态，放弃（含合并去重）
 *
 * 细状态归属：
 *   draft            → draft
 *   tagging          → draft（打标未完成，仍属草稿期）
 *   timing_missing   → draft（标已打、光位条件未完成，仍属草稿期）
 *   ready            → lit
 *   scheduled        → scheduled
 *   shot             → scheduled（拍完待归档，仍挂在排期链路上）
 *   archived         → archived
 *   dropped          → dropped
 */
export const LifecyclePhase = {
  draft: 'draft',
  lit: 'lit',
  scheduled: 'scheduled',
  archived: 'archived',
  dropped: 'dropped',
} as const;
export type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

export const LIFECYCLE_PHASES: LifecyclePhase[] = ['draft', 'lit', 'scheduled', 'archived', 'dropped'];

export const LIFECYCLE_PHASE_LABEL: Record<LifecyclePhase, string> = {
  draft: '草稿',
  lit: '布光',
  scheduled: '排期',
  archived: '归档',
  dropped: '放弃',
};

export const LIFECYCLE_TERMINAL: LifecyclePhase[] = ['archived', 'dropped'];

const STATUS_PHASE: Record<InspirationStatus, LifecyclePhase> = {
  draft: 'draft',
  tagging: 'draft',
  timing_missing: 'draft',
  ready: 'lit',
  scheduled: 'scheduled',
  shot: 'scheduled',
  archived: 'archived',
  dropped: 'dropped',
};

/** 细状态 → 五阶段 */
export function phaseOfStatus(status: InspirationStatus | string): LifecyclePhase {
  return STATUS_PHASE[status as InspirationStatus] ?? 'draft';
}

/**
 * 允许的阶段间转变（终态不可再出）。
 * 草稿链路上的自动细状态（tagging / timing_missing / shot）不产生审计事件。
 *   draft ⇄ lit ⇄ scheduled，三个活动阶段间可前进可回退（如取消计划回到布光）；
 *   archived / dropped 只能从任一活动阶段进入，且不可离开。
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecyclePhase, LifecyclePhase[]> = {
  draft: ['lit', 'archived', 'dropped'],
  lit: ['draft', 'scheduled', 'archived', 'dropped'],
  scheduled: ['lit', 'draft', 'archived', 'dropped'],
  archived: [],
  dropped: [],
};

export function canTransitionLifecycle(from: LifecyclePhase, to: LifecyclePhase): boolean {
  if (from === to) return false;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** 给定当前阶段，倒推哪些阶段可以"补录"成它的历史（补录闭环判定用） */
export function canReach(current: LifecyclePhase, target: LifecyclePhase): boolean {
  if (current === target) return true;
  if (LIFECYCLE_TERMINAL.includes(current)) {
    // 终态卡：只能补录终态本身或它之前的活动阶段
    return target === 'draft' || target === 'lit' || target === 'scheduled';
  }
  // 活动卡：不能补录一个终态（终态必须真实发生、会改卡片状态）
  return target !== 'archived' && target !== 'dropped';
}

/** 转变原因 → 展示文案（detail 里保留原始 reason） */
export const LIFECYCLE_REASON_LABEL: Record<string, string> = {
  created: '创建灵感卡',
  ready: '标签与光线条件齐备，进入布光',
  plan_created: '接单出行，进入排期',
  plan_cancelled: '出行计划取消，退回布光',
  manual: '人工调整',
  merged: '合并到保留卡，放弃',
  backfilled: '离线补录',
  bootstrapped: '历史数据迁移补基线',
};

/** 审计事件类型 */
export const LifecycleEventKind = {
  genesis: 'genesis', // 生命周期起点（创建 / 历史数据基线）
  transition: 'transition', // 阶段间转变
} as const;
export type LifecycleEventKind = (typeof LifecycleEventKind)[keyof typeof LifecycleEventKind];
