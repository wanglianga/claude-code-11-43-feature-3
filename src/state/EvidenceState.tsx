// 证据模块全局状态：已提交材料、当前推导、未提交预览、未完成计算分别持久化与恢复
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
import { useAppState } from './AppState';
import {
  KV_KEYS,
  getAllEvidenceRuns,
  kvCompareAndSwap,
  kvDelete,
  kvGet,
  kvSet,
  saveEvidenceRun,
} from '../lib/db';
import { loadEvidenceDataset, sessionsFromRows } from '../evidence/loadEvidence';
import {
  affectedJudgmentIds,
  applyChange,
  computeFullDerivation,
  computeTargetedUpdate,
  previewImpact,
  snapshotRun,
  verifyAgainstFullRecompute,
  type EvidenceChange,
} from '../evidence/store';
import type {
  DerivationStore,
  EvidenceDataset,
  EvidenceRun,
  ImpactPreviewResult,
  JudgmentState,
  MaterialStore,
} from '../evidence/types';
import type { SessionInfo } from '../evidence/derive';

export interface DerivationJob {
  jobId: string;
  change: EvidenceChange;
  affectedIds: string[];
  baseRevision: number;
  targetRevision: number;
  startedAt: string;
  status: 'RUNNING';
}

export interface StaleComputation {
  jobId: string;
  changeDescription: string;
  baseRevision: number;
  supersededByRevision: number;
  computedAt: string;
  transitions: Array<{ judgmentId: string; before: JudgmentState | null; after: JudgmentState | null; reason: string }>;
}

interface PreviewDraft {
  change: EvidenceChange;
  preview: ImpactPreviewResult;
  savedAt: string;
}

export interface EvidenceConflict {
  localRevision: number;
  remoteRevision: number;
}

interface EvidenceStateValue {
  evidenceDataset: EvidenceDataset | null;
  materialStore: MaterialStore | null;
  derivation: DerivationStore | null;
  runs: EvidenceRun[];
  stale: StaleComputation[];
  draft: PreviewDraft | null;
  job: DerivationJob | null;
  conflict: EvidenceConflict | null;
  recovered: string[];
  busy: boolean;
  previewChange: (change: EvidenceChange) => Promise<void>;
  commitPreview: () => Promise<void>;
  discardPreview: () => Promise<void>;
  fullRecomputeCheck: () => Promise<{ consistent: boolean; mismatches: string[] }>;
  resetEvidence: () => Promise<void>;
  dismissConflict: () => void;
}

const EvidenceContext = createContext<EvidenceStateValue | null>(null);
const CHANNEL = 'campus-meal-dq-evidence';
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

let correctionSeq = 0;
const nextCorrectionId = () => `CORR-${Date.now().toString(36)}-${++correctionSeq}`;

export function EvidenceStateProvider({ children }: { children: ReactNode }) {
  const { dataset } = useAppState();
  const [evidenceDataset, setEvidenceDataset] = useState<EvidenceDataset | null>(null);
  const [materialStore, setMaterialStore] = useState<MaterialStore | null>(null);
  const [derivation, setDerivation] = useState<DerivationStore | null>(null);
  const [runs, setRuns] = useState<EvidenceRun[]>([]);
  const [stale, setStale] = useState<StaleComputation[]>([]);
  const [draft, setDraft] = useState<PreviewDraft | null>(null);
  const [job, setJob] = useState<DerivationJob | null>(null);
  const [conflict, setConflict] = useState<EvidenceConflict | null>(null);
  const [recovered, setRecovered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const revisionRef = useRef(0);

  const sessions: SessionInfo[] = useMemo(
    () => (dataset ? sessionsFromRows(dataset.rowsByBatch['meal-1'] ?? []) : []),
    [dataset],
  );

  useEffect(() => {
    revisionRef.current = materialStore?.revision ?? 0;
  }, [materialStore]);

  // ---------- 启动：分别恢复已提交材料、当前推导、未完成计算、未提交预览 ----------
  useEffect(() => {
    if (!dataset) return;
    let mounted = true;
    const notices: string[] = [];

    async function boot() {
      const ev = await loadEvidenceDataset();
      // 1. 已提交材料库
      let ms = await kvGet<MaterialStore>(KV_KEYS.evidenceMaterialStore);
      if (!ms) {
        ms = {
          revision: 1,
          materials: ev.seedMaterials,
          corrections: [],
          importedSupplements: [],
          updatedAt: new Date().toISOString(),
        };
        await kvSet(KV_KEYS.evidenceMaterialStore, ms);
      }
      // 2. 未完成计算任务：材料已提交但推导未落库 → 定向续算；残留任务 → 丢弃
      let der = await kvGet<DerivationStore>(KV_KEYS.evidenceDerivation);
      const pendingJob = await kvGet<DerivationJob>(KV_KEYS.evidenceJob);
      if (pendingJob && pendingJob.targetRevision === ms.revision) {
        const { next } = computeTargetedUpdate(ms, der ?? emptyDerivation(ms), pendingJob.affectedIds, ev, sessions, new Date().toISOString());
        der = next;
        await kvSet(KV_KEYS.evidenceDerivation, der);
        await kvDelete(KV_KEYS.evidenceJob);
        notices.push(`检测到上次关闭时未完成的计算（材料 r${ms.revision}），已按受影响集合补算完成`);
      } else if (pendingJob) {
        await kvDelete(KV_KEYS.evidenceJob);
        notices.push('检测到未生效的计算任务残留（材料未提交），已按当前材料版本丢弃');
      }
      // 3. 推导库缺失或版本错位（无任务记录的极端情况）→ 全量重算对齐
      if (!der || der.materialRevision !== ms.revision) {
        der = computeFullDerivation(ms, ev, sessions, new Date().toISOString());
        await kvSet(KV_KEYS.evidenceDerivation, der);
        notices.push(der.judgments.length > 0 ? '推导库已按当前材料全量重算对齐' : '推导库为空');
      }
      // 4. 初始快照（首次进入时建立基线运行）
      let runList = await getAllEvidenceRuns();
      if (runList.length === 0) {
        const run = snapshotRun(der, ms, `EVRUN-SEED-${ms.revision}`, '初始种子材料推导基线', new Date().toISOString());
        await saveEvidenceRun(run);
        runList = await getAllEvidenceRuns();
      }
      // 5. 未提交预览草稿
      const previewDraft = await kvGet<PreviewDraft>(KV_KEYS.evidencePreviewDraft);
      if (previewDraft) {
        setDraft(previewDraft);
        notices.push(`恢复未提交的预览：${previewDraft.preview.changeDescription}`);
      }
      const staleList = (await kvGet<StaleComputation[]>(KV_KEYS.evidenceStale)) ?? [];

      if (!mounted) return;
      setEvidenceDataset(ev);
      setMaterialStore(ms);
      setDerivation(der);
      setRuns(runList);
      setStale(staleList);
      setRecovered(notices);
    }

    boot().catch((err) => {
      console.error('证据模块启动失败', err);
    });

    const channel = new BroadcastChannel(CHANNEL);
    channelRef.current = channel;
    channel.onmessage = async (ev2: MessageEvent<{ type: string; revision: number }>) => {
      if (ev2.data?.type !== 'evidence-committed') return;
      const remote = ev2.data.revision;
      if (remote > revisionRef.current) {
        const local = revisionRef.current;
        const ms = await kvGet<MaterialStore>(KV_KEYS.evidenceMaterialStore);
        const der = await kvGet<DerivationStore>(KV_KEYS.evidenceDerivation);
        if (ms) setMaterialStore(ms);
        if (der) setDerivation(der);
        setRuns(await getAllEvidenceRuns());
        setConflict({ localRevision: local, remoteRevision: remote });
      }
    };
    return () => {
      mounted = false;
      channel.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  // ---------- 预览（保存草稿，未提交不影响正式结果） ----------
  const previewChange = useCallback(
    async (change: EvidenceChange) => {
      if (!evidenceDataset || !materialStore || !derivation) return;
      const preview = previewImpact(
        materialStore,
        derivation,
        change,
        evidenceDataset,
        sessions,
        new Date().toISOString(),
        nextCorrectionId(),
      );
      const nextDraft: PreviewDraft = { change, preview, savedAt: new Date().toISOString() };
      await kvSet(KV_KEYS.evidencePreviewDraft, nextDraft);
      setDraft(nextDraft);
    },
    [evidenceDataset, materialStore, derivation, sessions],
  );

  const discardPreview = useCallback(async () => {
    await kvDelete(KV_KEYS.evidencePreviewDraft);
    setDraft(null);
  }, []);

  // ---------- 提交：乐观锁 → 登记任务 → 定向重算 → 原子替换当前推导 ----------
  const commitPreview = useCallback(async () => {
    if (!evidenceDataset || !derivation || !draft) return;
    setBusy(true);
    try {
      // 乐观锁：提交前重读材料库，另一标签页已提交更高版本则拒绝
      const fresh = await kvGet<MaterialStore>(KV_KEYS.evidenceMaterialStore);
      if (!fresh || fresh.revision !== draft.preview.baseMaterialRevision) {
        setConflict({
          localRevision: draft.preview.baseMaterialRevision,
          remoteRevision: fresh?.revision ?? -1,
        });
        if (fresh) setMaterialStore(fresh);
        const der = await kvGet<DerivationStore>(KV_KEYS.evidenceDerivation);
        if (der) setDerivation(der);
        throw new EvidenceCommitConflictError(fresh?.revision ?? -1);
      }

      const now = new Date().toISOString();
      const nextStore = applyChange(fresh, draft.change, now, nextCorrectionId());
      const affected = affectedJudgmentIds(draft.change, nextStore, derivation, evidenceDataset, sessions);
      const jobRec: DerivationJob = {
        jobId: `JOB-${now.replace(/[-:T.Z]/g, '')}`,
        change: draft.change,
        affectedIds: affected,
        baseRevision: fresh.revision,
        targetRevision: nextStore.revision,
        startedAt: now,
        status: 'RUNNING',
      };
      // 先登记任务再提交材料：崩溃任一环节，重启后都能恢复一致状态
      await kvSet(KV_KEYS.evidenceJob, jobRec);
      setJob(jobRec);
      // 材料库提交走原子比较并写入：两个标签页同时提交时，后到者必定失败，不会交错出同一修订号
      const swapped = await kvCompareAndSwap<MaterialStore>(
        KV_KEYS.evidenceMaterialStore,
        (cur) => cur?.revision === fresh.revision,
        nextStore,
      );
      if (!swapped) {
        await kvDelete(KV_KEYS.evidenceJob);
        setJob(null);
        const latest = await kvGet<MaterialStore>(KV_KEYS.evidenceMaterialStore);
        if (latest) setMaterialStore(latest);
        setConflict({ localRevision: fresh.revision, remoteRevision: latest?.revision ?? -1 });
        throw new EvidenceCommitConflictError(latest?.revision ?? -1);
      }
      setMaterialStore(nextStore);

      // 计算（异步让出，模拟批量推导；期间另一标签页可能提交更正）
      await sleep(350);
      const { next, transitions } = computeTargetedUpdate(nextStore, derivation, affected, evidenceDataset, sessions, new Date().toISOString());

      // 提交前再校验：计算期间材料被另一标签页更正 → 结果留作旧资料计算，不覆盖当前推导
      const latest = await kvGet<MaterialStore>(KV_KEYS.evidenceMaterialStore);
      if (!latest || latest.revision !== nextStore.revision) {
        const staleRec: StaleComputation = {
          jobId: jobRec.jobId,
          changeDescription: draft.preview.changeDescription,
          baseRevision: nextStore.revision,
          supersededByRevision: latest?.revision ?? -1,
          computedAt: new Date().toISOString(),
          transitions,
        };
        const staleList = [...((await kvGet<StaleComputation[]>(KV_KEYS.evidenceStale)) ?? []), staleRec];
        await kvSet(KV_KEYS.evidenceStale, staleList);
        setStale(staleList);
        if (latest) setMaterialStore(latest);
        const der = await kvGet<DerivationStore>(KV_KEYS.evidenceDerivation);
        if (der) setDerivation(der);
        setConflict({ localRevision: nextStore.revision, remoteRevision: latest?.revision ?? -1 });
        await kvDelete(KV_KEYS.evidenceJob);
        setJob(null);
        await kvDelete(KV_KEYS.evidencePreviewDraft);
        setDraft(null);
        setRuns(await getAllEvidenceRuns());
        return;
      }

      // 原子替换当前推导 + 生成不可变运行快照 + 清理任务与草稿
      await kvSet(KV_KEYS.evidenceDerivation, next);
      const run = snapshotRun(next, nextStore, `EVRUN-${nextStore.revision}-${Date.now().toString(36)}`, draft.preview.changeDescription, new Date().toISOString());
      await saveEvidenceRun(run);
      await kvDelete(KV_KEYS.evidenceJob);
      await kvDelete(KV_KEYS.evidencePreviewDraft);
      setDerivation(next);
      setJob(null);
      setDraft(null);
      setRuns(await getAllEvidenceRuns());
      channelRef.current?.postMessage({ type: 'evidence-committed', revision: nextStore.revision });
    } finally {
      setBusy(false);
    }
  }, [evidenceDataset, derivation, draft, sessions]);

  // ---------- 全量重算校验：定向更新必须与从零全量推导一致 ----------
  const fullRecomputeCheck = useCallback(async () => {
    if (!evidenceDataset || !materialStore || !derivation) {
      return { consistent: false, mismatches: ['证据模块尚未就绪'] };
    }
    return verifyAgainstFullRecompute(derivation, materialStore, evidenceDataset, sessions, new Date().toISOString());
  }, [evidenceDataset, materialStore, derivation, sessions]);

  // ---------- 重置证据工作区 ----------
  const resetEvidence = useCallback(async () => {
    if (!evidenceDataset) return;
    const ms: MaterialStore = {
      revision: 1,
      materials: evidenceDataset.seedMaterials,
      corrections: [],
      importedSupplements: [],
      updatedAt: new Date().toISOString(),
    };
    const der = computeFullDerivation(ms, evidenceDataset, sessions, new Date().toISOString());
    await kvSet(KV_KEYS.evidenceMaterialStore, ms);
    await kvSet(KV_KEYS.evidenceDerivation, der);
    await kvDelete(KV_KEYS.evidenceJob);
    await kvDelete(KV_KEYS.evidencePreviewDraft);
    await kvSet(KV_KEYS.evidenceStale, []);
    const run = snapshotRun(der, ms, `EVRUN-SEED-${ms.revision}`, '重置后的种子材料推导基线', new Date().toISOString());
    await saveEvidenceRun(run);
    setMaterialStore(ms);
    setDerivation(der);
    setDraft(null);
    setJob(null);
    setStale([]);
    setRuns(await getAllEvidenceRuns());
    setConflict(null);
  }, [evidenceDataset, sessions]);

  const value = useMemo<EvidenceStateValue>(
    () => ({
      evidenceDataset,
      materialStore,
      derivation,
      runs,
      stale,
      draft,
      job,
      conflict,
      recovered,
      busy,
      previewChange,
      commitPreview,
      discardPreview,
      fullRecomputeCheck,
      resetEvidence,
      dismissConflict: () => setConflict(null),
    }),
    [evidenceDataset, materialStore, derivation, runs, stale, draft, job, conflict, recovered, busy, previewChange, commitPreview, discardPreview, fullRecomputeCheck, resetEvidence],
  );

  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

function emptyDerivation(ms: MaterialStore): DerivationStore {
  return {
    derivationRevision: ms.revision,
    materialRevision: ms.revision,
    computedAt: new Date().toISOString(),
    judgments: [],
    reverseIndex: {},
  };
}

export class EvidenceCommitConflictError extends Error {
  remoteRevision: number;
  constructor(remoteRevision: number) {
    super(`材料版本冲突：检测到更新的材料修订 r${remoteRevision}，本次提交被拒绝`);
    this.name = 'EvidenceCommitConflictError';
    this.remoteRevision = remoteRevision;
  }
}

export function useEvidenceState(): EvidenceStateValue {
  const ctx = useContext(EvidenceContext);
  if (!ctx) throw new Error('useEvidenceState 必须在 EvidenceStateProvider 内使用');
  return ctx;
}
