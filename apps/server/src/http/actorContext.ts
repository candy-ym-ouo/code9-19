import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthUser } from '@flil/shared';

/**
 * 生命周期审计的"责任人上下文"。
 *
 * 服务层（syncStatus / archive / merge …）本身不接触 Express 请求，
 * 但审计必须记下是谁触发的。鉴权中间件在每个请求入口把当前用户放进
 * AsyncLocalStorage，服务层直接 currentActor() 取用；
 * 任务脚本 / 种子等无请求场景退化为 system。
 */
export interface LifecycleActor {
  id: string | null;
  name: string;
  role: 'owner' | 'member' | 'system';
}

const SYSTEM_ACTOR: LifecycleActor = { id: null, name: 'system', role: 'system' };

const storage = new AsyncLocalStorage<LifecycleActor>();

export function runWithActor<T>(user: AuthUser | null, fn: () => T): T {
  const actor: LifecycleActor = user
    ? { id: user.id, name: user.displayName, role: user.role }
    : SYSTEM_ACTOR;
  return storage.run(actor, fn);
}

export function currentActor(): LifecycleActor {
  return storage.getStore() ?? SYSTEM_ACTOR;
}
