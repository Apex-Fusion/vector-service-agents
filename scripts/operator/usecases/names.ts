// scripts/operator/usecases/names.ts - the closed list of the use case names. The data of a use case is the file `usecases/<name>.ts`. The command line loads a use case only when its name is in this list.
export const USE_CASE_NAMES = ['inventory-reorder'] as const;

export type UseCaseName = (typeof USE_CASE_NAMES)[number];
