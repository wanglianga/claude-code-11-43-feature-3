import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AnalysisRun, MappingDocument, MappingState } from '../types';
import { loadDataset, type Dataset } from '../lib/loadDataset';
import {
  KV_KEYS,
  clearAll,
  deleteRun as idbDeleteRun,
  getAllRuns,
  getAllSnapshots,
  kvGet,
  kvSet,
  saveRun,
  saveSnapshot,
} from '../lib/db';
import { runEngine } from '../engine/runEngine';
import { RULE_VERSION } from '../engine/rules';

export interface MappingConflict {
  localRevision: number;
  remoteRevision: number;
  remoteModifiedAt: string;
}

interface AppStateValue {
  dataset: Dataset | null;
  mappingState: MappingState | null;
  runs: AnalysisRun[];
  loading: boolean;
  loadError: string | null;
  conflict: MappingConflict | null;
  currentRun: AnalysisRun | null;
  refreshCurrentRun: () => void;
  saveMapping: (draft: MappingDocument, baseRevision: number) => Promise<void>;
  reloadMapping: () => Promise<void>;
  createRun: (note?: string) => Promise<AnalysisRun>;
  removeRun: (runId: string) => Promise<void>;
  resetWorkspace: () => Promise<void>;
  dismissConflict: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

const CHANNEL_NAME = 'campus-meal-dq-mapping';

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [mappingState, setMappingState] = useState<MappingState | null>(null);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MappingConflict | null>(null);
  const [currentRun, setCurrentRun] = useState<AnalysisRun | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const mappingStateRef = useRef<MappingState | null>(null);
  mappingStateRef.current = mappingState;

  const refreshCurrentRun = useCallback(() => {
    if (!dataset || !mappingStateRef.current) return;
    setCurrentRun(runEngine(dataset, mappingStateRef.current.doc, { mappingRevision: mappingStateRef.current.revision }));
  }, [dataset]);

  const reloadMapping = useCallback(async () => {
    const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
    if (fresh) {
      setMappingState(fresh);
      setConflict(null);
      if (dataset) setCurrentRun(runEngine(dataset, fresh.doc, { mappingRevision: fresh.revision }));
    }
  }, [dataset]);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      try {
        const ds = await loadDataset();
        if (!mounted) return;
        setDataset(ds);

        // 输入快照：记录本次分析固定引用的文件哈希
        await saveSnapshot({
          id: `input-${ds.metaHashes.manifest.slice(0, 10)}`,
          kind: 'INPUT_SNAPSHOT',
          createdAt: new Date().toISOString(),
          payload: {
            manifestHash: ds.metaHashes.manifest,
            fileHashes: ds.hashes,
            batches: ds.manifest.batches.map((b) => ({
              batchId: b.batchId,
              status: b.status,
              expectedRows: b.expectedRows,
            })),
          },
        });

        let state = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (!state) {
          // 首次进入：以随项目提供的种子映射初始化
          state = {
            doc: ds.seedMapping,
            revision: 1,
            lastModifiedAt: ds.seedMapping.updatedAt,
          };
          await kvSet(KV_KEYS.mappingState, state);
        }
        if (!mounted) return;
        setMappingState(state);
        setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
        setRuns(await getAllRuns());
        await getAllSnapshots(); // 触发索引，快照可在后续页面读取
        setLoading(false);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    bootstrap();

    // 跨标签页：其他标签页保存映射后广播，当前标签页检测版本落后即进入冲突态
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async (ev: MessageEvent<{ type: string; revision: number; modifiedAt: string }>) => {
      if (ev.data?.type !== 'mapping-saved') return;
      const local = mappingStateRef.current;
      if (local && ev.data.revision > local.revision) {
        const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (fresh) {
          setMappingState(fresh);
          setConflict({
            localRevision: local.revision,
            remoteRevision: ev.data.revision,
            remoteModifiedAt: ev.data.modifiedAt,
          });
        }
      }
    };

    return () => {
      mounted = false;
      channel.close();
    };
  }, []);

  const saveMapping = useCallback(
    async (draft: MappingDocument, baseRevision: number) => {
      if (!dataset) throw new Error('数据尚未加载完成');
      // 保存时重新读取 IDB：若另一标签页已提交更高版本，拒绝覆盖并要求重载
      const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
      if (fresh && fresh.revision !== baseRevision) {
        setMappingState(fresh);
        setConflict({
          localRevision: baseRevision,
          remoteRevision: fresh.revision,
          remoteModifiedAt: fresh.lastModifiedAt,
        });
        throw new MappingSaveConflictError(fresh.revision);
      }
      const now = new Date().toISOString();
      const next: MappingState = {
        doc: { ...draft, ruleVersion: RULE_VERSION, updatedAt: now },
        revision: (fresh?.revision ?? baseRevision) + 1,
        lastModifiedAt: now,
      };
      await kvSet(KV_KEYS.mappingState, next);
      await saveSnapshot({
        id: `mapping-v${next.revision}-${next.doc.mappingVersion}`,
        kind: 'MAPPING_SNAPSHOT',
        createdAt: now,
        payload: next,
      });
      setMappingState(next);
      setCurrentRun(runEngine(dataset, next.doc, { mappingRevision: next.revision }));
      channelRef.current?.postMessage({
        type: 'mapping-saved',
        revision: next.revision,
        modifiedAt: now,
      });
    },
    [dataset],
  );

  const createRun = useCallback(async () => {
    if (!dataset || !mappingStateRef.current) throw new Error('数据尚未加载完成');
    const state = mappingStateRef.current;
    const run = runEngine(dataset, state.doc, { mappingRevision: state.revision });
    await saveRun(run);
    setRuns(await getAllRuns());
    return run;
  }, [dataset]);

  const removeRun = useCallback(async (runId: string) => {
    await idbDeleteRun(runId);
    setRuns(await getAllRuns());
  }, []);

  const resetWorkspace = useCallback(async () => {
    await clearAll();
    const ds = await loadDataset();
    setDataset(ds);
    const state: MappingState = {
      doc: ds.seedMapping,
      revision: 1,
      lastModifiedAt: ds.seedMapping.updatedAt,
    };
    await kvSet(KV_KEYS.mappingState, state);
    setMappingState(state);
    setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
    setRuns([]);
    setConflict(null);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
      dismissConflict: () => setConflict(null),
    }),
    [
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export class MappingSaveConflictError extends Error {
  remoteRevision: number;
  constructor(remoteRevision: number) {
    super(`映射版本冲突：检测到更新的修订版本 r${remoteRevision}，请重载后再编辑`);
    this.name = 'MappingSaveConflictError';
    this.remoteRevision = remoteRevision;
  }
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState 必须在 AppStateProvider 内使用');
  return ctx;
}
