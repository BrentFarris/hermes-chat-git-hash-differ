export interface Route { connectionId: string; profile: string; targetProfile: string; mode: 'local' | 'remote'; sessionId: string; storedId: string }
export interface Commit { id: string; sha: string; subject: string; author: string; date: string; parents: string[]; parent: string; repo_id: string; repo_name: string; file_count: number | null; reviewed_count: number; occurrences: number; problem?: { message: string } }
export interface Repo { id: string; path: string; name: string }
export interface Snapshot { session: { id: string; title: string }; commits: Commit[]; repositories: Repo[]; unresolved: { hash: string; reason: string; hint?: string; repositories: string[]; occurrences: number }[]; errors: { code: string; message: string }[]; scanning: boolean; auto_open: boolean }
export interface ChangedFile { id: string; path: string; old_path: string; status: string; added: number | null; deleted: number | null; binary: boolean; reviewed: boolean }
export interface Listing { commit: Commit; parent: string; files: ChangedFile[] }
export interface DiffLine { kind: 'context' | 'add' | 'delete' | 'note'; text: string; old: number | null; new: number | null }
export interface FileDiff { kind: string; message?: string; context?: number; hunks: { header: string; lines: DiffLine[] }[] }
export interface Storage { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
export interface ReviewState { snapshot: Snapshot | null; commitId: string | null; parent: string | null; fileId: string | null; listing: Listing | null; diff: FileDiff | null; loading: boolean; refreshing: boolean; error: string; context: number; saving: string[]; revision: number; navigation: number }
export type RPC = <T>(route: Route, method: string, params?: Record<string, unknown>) => Promise<T>;
