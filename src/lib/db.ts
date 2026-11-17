import { openDB, type IDBPDatabase } from 'idb';
import type { AnalysisRun, MappingState } from '../types';
import type { EvidenceRun } from '../evidence/types';

const DB_NAME = 'campus-meal-dq';
const DB_VERSION = 2;

export interface SnapshotRecord {
  id: string;
  kind: 'INPUT_SNAPSHOT' | 'MAPPING_SNAPSHOT';
  payload: unknown;
  createdAt: string;
}

interface DBSchema {
  kv: { key: string; value: unknown };
  runs: { key: string; value: AnalysisRun };
  snapshots: { key: string; value: SnapshotRecord };
  evidenceRuns: { key: string; value: EvidenceRun };
}

let dbPromise: Promise<IDBPDatabase<DBSchema>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<DBSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('kv')) {
          database.createObjectStore('kv', { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains('runs')) {
          database.createObjectStore('runs', { keyPath: 'summary.runId' });
        }
        if (!database.objectStoreNames.contains('snapshots')) {
          database.createObjectStore('snapshots', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('evidenceRuns')) {
          database.createObjectStore('evidenceRuns', { keyPath: 'runId' });
        }
      },
    });
  }
  return dbPromise;
}

// ---------- KV（映射状态、证据材料库、推导库、预览草稿、计算任务等单例对象） ----------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const rec = await (await db()).get('kv', key);
  return rec ? (rec as { value: T }).value : undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', { key, value });
}

export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete('kv', key);
}

/**
 * 原子比较并写入（同一 IDB 事务内完成读-校验-写）：
 * 用于材料库等单例对象的乐观锁提交，杜绝两个标签页交错写入同一修订号。
 */
export async function kvCompareAndSwap<T>(
  key: string,
  expect: (current: T | undefined) => boolean,
  value: T,
): Promise<boolean> {
  const database = await db();
  const tx = database.transaction('kv', 'readwrite');
  const store = tx.objectStore('kv');
  const rec = await store.get(key);
  const current = rec ? (rec as { value: T }).value : undefined;
  if (!expect(current)) {
    await tx.done;
    return false;
  }
  await store.put({ key, value });
  await tx.done;
  return true;
}

// ---------- 分析运行 ----------

export async function saveRun(run: AnalysisRun): Promise<void> {
  await (await db()).put('runs', run);
}

export async function getAllRuns(): Promise<AnalysisRun[]> {
  const runs = await (await db()).getAll('runs');
  return runs.sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt));
}

export async function getRun(runId: string): Promise<AnalysisRun | undefined> {
  return (await db()).get('runs', runId);
}

export async function deleteRun(runId: string): Promise<void> {
  await (await db()).delete('runs', runId);
}

// ---------- 快照 ----------

export async function saveSnapshot(rec: SnapshotRecord): Promise<void> {
  await (await db()).put('snapshots', rec);
}

export async function getAllSnapshots(): Promise<SnapshotRecord[]> {
  const recs = await (await db()).getAll('snapshots');
  return recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- 证据推导运行（不可变快照） ----------

export async function saveEvidenceRun(run: EvidenceRun): Promise<void> {
  await (await db()).put('evidenceRuns', run);
}

export async function getAllEvidenceRuns(): Promise<EvidenceRun[]> {
  const runs = await (await db()).getAll('evidenceRuns');
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteEvidenceRun(runId: string): Promise<void> {
  await (await db()).delete('evidenceRuns', runId);
}

export async function clearAll(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear('kv'),
    database.clear('runs'),
    database.clear('snapshots'),
    database.clear('evidenceRuns'),
  ]);
}

export const KV_KEYS = {
  mappingState: 'mapping-state',
  lastDataset: 'last-dataset',
  /** 证据模块：已提交材料库（含更正记录与修订号） */
  evidenceMaterialStore: 'evidence-material-store',
  /** 证据模块：当前推导库（支持路径 + 反向依赖，原子整体替换） */
  evidenceDerivation: 'evidence-derivation',
  /** 证据模块：未提交的补证/撤回预览草稿 */
  evidencePreviewDraft: 'evidence-preview-draft',
  /** 证据模块：未完成计算任务（页面关闭后恢复续算） */
  evidenceJob: 'evidence-job',
  /** 证据模块：被并发更正取代的旧资料计算（留档，不覆盖当前推导） */
  evidenceStale: 'evidence-stale',
} as const;

export type { MappingState };
