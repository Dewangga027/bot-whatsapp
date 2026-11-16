import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { IntegrationContext } from './integration.js';

export type CommitBoundary = 'before-commit' | 'after-commit';
export type CrashProcess = {
  child: ChildProcess;
  boundary: Promise<void>;
  kill: () => Promise<void>;
};

export function spawnCrashWorker(context: IntegrationContext, phase: CommitBoundary): CrashProcess {
  const child = fork(new URL('./crash-worker.ts', import.meta.url), [
    phase, context.workerConfig.database.database, String(context.redisOptions.db),
  ], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const { promise: boundary, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => finish(new Error('Crash worker did not reach SQL boundary')), 15_000);
  function finish(error?: Error): void {
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('error', onError);
    child.off('exit', onExit);
    if (error) { reject(error); } else { resolve(); }
  }
  function onMessage(message: unknown): void {
    if (message === phase) { finish(); }
    else if (message === 'worker-error') { finish(new Error('Crash worker failed before SQL boundary')); }
  }
  function onError(): void { finish(new Error('Crash worker could not start')); }
  function onExit(): void { finish(new Error('Crash worker exited before SQL boundary')); }
  child.on('message', onMessage);
  child.once('error', onError);
  child.once('exit', onExit);
  // Enqueue may fail before the caller reaches its boundary await.
  void boundary.catch(() => {});
  return {
    child, boundary,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) { return; }
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
