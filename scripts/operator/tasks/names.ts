// scripts/operator/tasks/names.ts - the closed list of the task names. A task is the file `tasks/<name>.ts`. The command line loads a task only when its name is in this list.
export const TASK_NAMES = ['keys', 'fund', 'register', 'stake', 'advert', 'attest', 'claim', 'allowlist', 'env', 'tenant', 'fault', 'probe', 'hold', 'delegations', 'evidence', 'results', 'end-state'] as const;

export type TaskName = (typeof TASK_NAMES)[number];
