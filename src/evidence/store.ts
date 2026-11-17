// 推导库：保存支持路径与反向依赖，材料变化时定向重算；另提供全量重算校验一致性
import type {
  CorrectionRecord,
  DerivationStore,
  EvidenceDataset,
  EvidenceMaterial,
  EvidenceRun,
  ImpactPreviewResult,
  IngredientJudgment,
  JudgmentState,
  MaterialStore,
} from './types';
import { JUDGMENT_STATE_ORDER } from './types';
import { applyCorrections } from './materials';
import {
  buildReverseIndex,
  deriveAllJudgments,
  deriveJudgment,
  __buildCtxForTest as buildCtx,
  type DeriveInput,
  type SessionInfo,
} from './derive';

/** 分析师可提交的材料变更 */
export type EvidenceChange =
  | { type: 'WITHDRAW'; materialId: string; note: string }
  | {
      type: 'RECTIFY_SCOPE';
      materialId: string;
      note: string;
      newScope: { scopeType: 'POTS' | 'ALL_DAY' | 'UNCLEAR'; potIds?: string[]; fullReplacement?: boolean };
    }
  | { type: 'IMPORT_SUPPLEMENT'; batchId: string };

export const CHANGE_LABEL: Record<EvidenceChange['type'], string> = {
  WITHDRAW: '撤回材料',
  RECTIFY_SCOPE: '更正适用范围',
  IMPORT_SUPPLEMENT: '导入补证批次',
};

export function emptyStateCounts(): Record<JudgmentState, number> {
  return {
    CONFIRMED_PRESENT: 0,
    LABEL_MAY_CONTAIN: 0,
    PLANNED_USE: 0,
    INDIRECT_CLUE: 0,
    INSUFFICIENT: 0,
    CONFLICT: 0,
  };
}

export function countStates(judgments: IngredientJudgment[]): Record<JudgmentState, number> {
  const counts = emptyStateCounts();
  judgments.forEach((j) => {
    counts[j.state] += 1;
  });
  return counts;
}

function deriveInputOf(
  materials: EvidenceMaterial[],
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
  materialRevision: number,
): DeriveInput {
  return {
    materials,
    ingredientMap: dataset.ingredientMap,
    sessions,
    materialRevision,
  };
}

/** 全量推导（每次纠错较少维护中间状态的口径；也用于校验定向重算） */
export function computeFullDerivation(
  store: MaterialStore,
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
  now: string,
): DerivationStore {
  const effective = effectiveMaterials(store);
  const input = deriveInputOf(effective, dataset, sessions, store.revision);
  const judgments = deriveAllJudgments(input);
  return {
    derivationRevision: store.revision,
    materialRevision: store.revision,
    computedAt: now,
    judgments,
    reverseIndex: buildReverseIndex(judgments, input),
  };
}

/** 计算一次变更影响到的判断 id 集合（撤回/更正沿反向依赖；补证按内容定位） */
export function affectedJudgmentIds(
  change: EvidenceChange,
  store: MaterialStore,
  derivation: DerivationStore,
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
): string[] {
  const affected = new Set<string>();
  if (change.type === 'IMPORT_SUPPLEMENT') {
    const newMaterials = store.materials.filter((m) => m.supplement && m.batchId === change.batchId);
    const effective = effectiveMaterials(store);
    const ctx = buildCtx(deriveInputOf(effective, dataset, sessions, store.revision));
    const sessionKeys = new Map<string, Set<string>>();
    const addKey = (sessionId: string | undefined, keys: string[]) => {
      if (!sessionId) return;
      const set = sessionKeys.get(sessionId) ?? new Set<string>();
      keys.forEach((k) => set.add(k));
      sessionKeys.set(sessionId, set);
    };
    for (const m of newMaterials) {
      if (m.kind === 'ACTUAL_INPUT') {
        for (const potId of m.scope.potIds ?? []) {
          const pot = ctx.potById.get(potId);
          const keys = new Set<string>();
          // 名称映射 + 该商品全部声明键
          const nameKeys = dataset.ingredientMap[m.attrs.ingredient_name ?? ''] ?? [];
          nameKeys.forEach((k) => keys.add(k));
          store.materials
            .filter((d) => d.kind === 'PRODUCT_DECLARATION' && d.attrs.product_code === m.attrs.product_code)
            .forEach((d) => keys.add(d.attrs.component_key ?? ''));
          addKey(pot?.scope.sessionId, Array.from(keys));
        }
      } else if (m.scope.sessionId) {
        const keys = new Set<string>();
        (dataset.ingredientMap[m.attrs.ingredient_name ?? ''] ?? []).forEach((k) => keys.add(k));
        if (m.kind === 'SUBSTITUTION') {
          (dataset.ingredientMap[m.attrs.replaced_ingredient ?? ''] ?? []).forEach((k) => keys.add(k));
          (dataset.ingredientMap[m.attrs.substitute_ingredient ?? ''] ?? []).forEach((k) => keys.add(k));
        }
        if (m.kind === 'PRODUCT_DECLARATION') keys.add(m.attrs.component_key ?? '');
        addKey(m.scope.sessionId, Array.from(keys));
      }
    }
    sessionKeys.forEach((keys, sid) => {
      keys.forEach((k) => affected.add(`${sid}|${k}`));
    });
    return Array.from(affected).sort();
  }

  // WITHDRAW / RECTIFY_SCOPE：沿反向依赖找受影响判断
  const ids = derivation.reverseIndex[change.materialId] ?? [];
  ids.forEach((id) => affected.add(id));
  return Array.from(affected).sort();
}

/** 应用变更得到新的材料库（更正记录只追加；补证导入登记批次） */
export function applyChange(
  store: MaterialStore,
  change: EvidenceChange,
  now: string,
  correctionId: string,
): MaterialStore {
  const corrections: CorrectionRecord[] = [...store.corrections];
  let importedSupplements = store.importedSupplements;
  if (change.type === 'WITHDRAW') {
    corrections.push({
      correctionId,
      type: 'WITHDRAW',
      targetMaterialId: change.materialId,
      note: change.note,
      createdAt: now,
    });
  } else if (change.type === 'RECTIFY_SCOPE') {
    corrections.push({
      correctionId,
      type: 'RECTIFY_SCOPE',
      targetMaterialId: change.materialId,
      note: change.note,
      createdAt: now,
      newScope: {
        scopeType: change.newScope.scopeType,
        potIds: change.newScope.potIds,
        fullReplacement: change.newScope.fullReplacement,
      },
    });
  } else if (change.type === 'IMPORT_SUPPLEMENT') {
    if (!importedSupplements.includes(change.batchId)) {
      importedSupplements = [...importedSupplements, change.batchId];
    }
  }
  return {
    revision: store.revision + 1,
    materials: store.materials,
    corrections,
    importedSupplements,
    updatedAt: now,
  };
}

/** 当前有效材料：应用更正，并过滤掉未导入的补证批次 */
export function effectiveMaterials(store: MaterialStore): EvidenceMaterial[] {
  const visible = store.materials.filter(
    (m) => !m.supplement || store.importedSupplements.includes(m.batchId),
  );
  return applyCorrections(visible, store.corrections);
}

/**
 * 定向重算：只重推导受影响判断，其余判断保持（支持路径与反向依赖随结果一并更新）。
 * 返回新推导库；transitionExplanations 记录每个受影响判断的变化原因（保留/转未知）。
 */
export function computeTargetedUpdate(
  store: MaterialStore,
  derivation: DerivationStore,
  affectedIds: string[],
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
  now: string,
): { next: DerivationStore; transitions: Array<{ judgmentId: string; before: JudgmentState | null; after: JudgmentState | null; reason: string }> } {
  const effective = effectiveMaterials(store);
  const input = deriveInputOf(effective, dataset, sessions, store.revision);
  const ctx = buildCtx(input);
  const beforeById = new Map(derivation.judgments.map((j) => [j.judgmentId, j]));

  const transitions: Array<{ judgmentId: string; before: JudgmentState | null; after: JudgmentState | null; reason: string }> = [];
  const replaced = new Map<string, IngredientJudgment | null>();
  for (const id of affectedIds) {
    const [sessionId, key] = id.split('|');
    const next = deriveJudgment(sessionId, key, ctx);
    const before = beforeById.get(id) ?? null;
    replaced.set(id, next);
    transitions.push({
      judgmentId: id,
      before: before?.state ?? null,
      after: next?.state ?? null,
      reason: transitionReason(before, next),
    });
  }

  const judgments = derivation.judgments
    .map((j) => (replaced.has(j.judgmentId) ? replaced.get(j.judgmentId)! : j))
    .filter((j): j is IngredientJudgment => Boolean(j));
  replaced.forEach((j, id) => {
    if (j && !beforeById.has(id)) judgments.push(j);
  });
  judgments.sort((a, b) => a.judgmentId.localeCompare(b.judgmentId));

  const nextInput = deriveInputOf(effective, dataset, sessions, store.revision);
  return {
    next: {
      derivationRevision: store.revision,
      materialRevision: store.revision,
      computedAt: now,
      judgments,
      reverseIndex: buildReverseIndex(judgments, nextInput),
    },
    transitions,
  };
}

function transitionReason(before: IngredientJudgment | null, after: IngredientJudgment | null): string {
  if (!before && after) return `新增判断：${after.state}`;
  if (before && !after) return '判断随材料变化移除';
  if (!before || !after) return '';
  if (before.state === after.state) {
    if (after.state === 'CONFIRMED_PRESENT') {
      return '仍有另一条完整且适用的独立支持路径，结论保留（路径与缺口已重算）';
    }
    return '状态未变（支持路径与缺口已随材料重算）';
  }
  if (before.state === 'CONFIRMED_PRESENT' && (after.state === 'INSUFFICIENT' || after.state === 'INDIRECT_CLUE' || after.state === 'PLANNED_USE')) {
    return '最后一条完整支持已撤回/失效，转为未确认；这不证明相反结论，不能统计为无过敏原';
  }
  return `状态由 ${before.state} 变为 ${after.state}`;
}

/** 影响预览：不提交、不生成正式运行；给出受影响餐次/成分/数量与前后对比 */
export function previewImpact(
  store: MaterialStore,
  derivation: DerivationStore,
  change: EvidenceChange,
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
  now: string,
  correctionId: string,
): ImpactPreviewResult {
  const draftStore = applyChange(store, change, now, correctionId);
  const affected = affectedJudgmentIds(change, draftStore, derivation, dataset, sessions);
  const { next, transitions } = computeTargetedUpdate(draftStore, derivation, affected, dataset, sessions, now);

  return {
    changeDescription: describeChange(change, store),
    affectedJudgments: transitions.map((t) => ({
      judgmentId: t.judgmentId,
      sessionId: t.judgmentId.split('|')[0],
      componentKey: t.judgmentId.split('|')[1],
      before: t.before,
      after: t.after,
      reason: t.reason,
    })),
    countsBefore: countStates(derivation.judgments),
    countsAfter: countStates(next.judgments),
    baseMaterialRevision: store.revision,
    previewedAt: now,
  };
}

function describeChange(change: EvidenceChange, store: MaterialStore): string {
  if (change.type === 'WITHDRAW') {
    return `撤回材料 ${change.materialId}（${change.note || '未填写原因'}）`;
  }
  if (change.type === 'RECTIFY_SCOPE') {
    const m = store.materials.find((x) => x.materialId === change.materialId);
    return `更正 ${change.materialId}（${m?.attrs.replaced_ingredient ?? ''}→${m?.attrs.substitute_ingredient ?? ''}）适用范围为 ${change.newScope.scopeType}${change.newScope.potIds?.length ? `（${change.newScope.potIds.join('、')}）` : ''}`;
  }
  return `导入补证批次 ${change.batchId}`;
}

/** 生成不可变推导运行快照（旧运行保留当时解释，不被新证据静默替换） */
export function snapshotRun(
  derivation: DerivationStore,
  store: MaterialStore,
  runId: string,
  note: string,
  now: string,
): EvidenceRun {
  return {
    runId,
    createdAt: now,
    note,
    materialRevision: store.revision,
    derivationRevision: derivation.derivationRevision,
    stats: countStates(derivation.judgments),
    judgments: structuredClone(derivation.judgments),
    correctionsApplied: store.corrections.map((c) => c.correctionId),
  };
}

/** 全量重算校验：定向更新结果必须与从零全量推导一致（可追查且一致） */
export function verifyAgainstFullRecompute(
  targeted: DerivationStore,
  store: MaterialStore,
  dataset: EvidenceDataset,
  sessions: SessionInfo[],
  now: string,
): { consistent: boolean; mismatches: string[] } {
  const full = computeFullDerivation(store, dataset, sessions, now);
  const mismatches: string[] = [];
  const targetedById = new Map(targeted.judgments.map((j) => [j.judgmentId, j]));
  const fullById = new Map(full.judgments.map((j) => [j.judgmentId, j]));
  for (const [id, fj] of fullById) {
    const tj = targetedById.get(id);
    if (!tj) {
      mismatches.push(`${id}: 定向结果缺失`);
      continue;
    }
    if (tj.state !== fj.state) mismatches.push(`${id}: 状态 ${tj.state} ≠ 全量 ${fj.state}`);
    if (tj.paths.length !== fj.paths.length) mismatches.push(`${id}: 路径数 ${tj.paths.length} ≠ 全量 ${fj.paths.length}`);
    if (tj.opposites.length !== fj.opposites.length) mismatches.push(`${id}: 相反记录数不一致`);
    if (tj.conflicts.length !== fj.conflicts.length) mismatches.push(`${id}: 冲突数不一致`);
  }
  for (const id of targetedById.keys()) {
    if (!fullById.has(id)) mismatches.push(`${id}: 定向结果多出判断`);
  }
  return { consistent: mismatches.length === 0, mismatches };
}

export { JUDGMENT_STATE_ORDER };
