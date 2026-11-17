import { describe, expect, it } from 'vitest';
import { loadTestDataset } from '../test/loadTestDataset';
import { loadTestEvidence } from '../test/loadTestEvidence';
import { sessionsFromRows } from './loadEvidence';
import { buildEvidenceExport, judgmentsToCsv } from '../lib/evidenceExport';
import {
  affectedJudgmentIds,
  applyChange,
  computeFullDerivation,
  computeTargetedUpdate,
  countStates,
  effectiveMaterials,
  previewImpact,
  snapshotRun,
  verifyAgainstFullRecompute,
  type EvidenceChange,
} from './store';
import { supportRootsOf, countIndependentSupports } from './graph';
import type { DerivationStore, EvidenceDataset, MaterialStore } from './types';
import type { SessionInfo } from './derive';

const mainDataset = await loadTestDataset();
const evidence: EvidenceDataset = await loadTestEvidence();
const sessions: SessionInfo[] = sessionsFromRows(mainDataset.rowsByBatch['meal-1'] ?? []);

const NOW = '2026-09-12T10:00:00.000Z';
let correctionSeq = 0;
const nextCorrectionId = () => `CORR-T${++correctionSeq}`;

function seedStore(): MaterialStore {
  return {
    revision: 1,
    materials: evidence.seedMaterials,
    corrections: [],
    importedSupplements: [],
    updatedAt: NOW,
  };
}

const seed = seedStore();
const derivation = computeFullDerivation(seed, evidence, sessions, NOW);
const byId = new Map(derivation.judgments.map((j) => [j.judgmentId, j]));

function get(id: string) {
  const j = byId.get(id);
  if (!j) throw new Error(`缺少判断 ${id}`);
  return j;
}

/** 对种子库依次应用变更并定向重算，返回最新材料库与推导库 */
function applyAndUpdate(
  store: MaterialStore,
  der: DerivationStore,
  change: EvidenceChange,
): { store: MaterialStore; derivation: DerivationStore } {
  const nextStore = applyChange(store, change, NOW, nextCorrectionId());
  const affected = affectedJudgmentIds(change, nextStore, der, evidence, sessions);
  const { next } = computeTargetedUpdate(nextStore, der, affected, evidence, sessions, NOW);
  return { store: nextStore, derivation: next };
}

describe('证据材料加载', () => {
  it('七类材料 + 转抄 + 补证批次全部解析，保留身份/批次/范围/原始行/引用', () => {
    const kinds = new Set(evidence.seedMaterials.map((m) => m.kind));
    ['PLAN_RECIPE', 'REQUISITION', 'ACTUAL_INPUT', 'PRODUCTION_BATCH', 'SUBSTITUTION', 'SERVING_DESTINATION', 'PRODUCT_DECLARATION', 'TRANSCRIPTION'].forEach((k) =>
      expect(kinds.has(k as never)).toBe(true),
    );
    const sub = evidence.seedMaterials.find((m) => m.materialId === 'SUB-A-OIL')!;
    expect(sub.scope.scopeType).toBe('UNCLEAR');
    expect(sub.batchId).toBe('ev-sub-1');
    expect(sub.rowId).toContain('ev-sub-1#L');
    const rpt = evidence.seedMaterials.find((m) => m.materialId === 'RPT-B-0902')!;
    expect(rpt.cites).toEqual(['REQ-B-0902-SAL']);
    const supp = evidence.seedMaterials.find((m) => m.materialId === 'INPUT-A-L2')!;
    expect(supp.supplement).toBe(true);
  });

  it('补证批次默认不进入有效材料', () => {
    const eff = effectiveMaterials(seed);
    expect(eff.some((m) => m.materialId === 'INPUT-A-L2')).toBe(false);
    expect(eff.length).toBe(evidence.seedMaterials.length - 1);
  });
});

describe('种子推导：六态齐备且全部由材料生成', () => {
  it('十个判断覆盖全部六态', () => {
    expect(derivation.judgments).toHaveLength(10);
    const counts = countStates(derivation.judgments);
    expect(counts.CONFIRMED_PRESENT).toBe(5); // 乳×2、芝麻(晚餐)、甲壳类(9/2)、鱼
    expect(counts.LABEL_MAY_CONTAIN).toBe(1); // 花生@MS-A-0901-L
    expect(counts.PLANNED_USE).toBe(1); // 芝麻@MS-A-0901-L
    expect(counts.INDIRECT_CLUE).toBe(1); // 甲壳类@MS-B-0901-D
    expect(counts.INSUFFICIENT).toBe(1); // 花生@MS-A-0901-D（仅循环引用）
    expect(counts.CONFLICT).toBe(1); // 蛋@MS-B-0901-L
  });

  it('场景1 分锅部分替换：计划用芝麻油 + 范围未登记的替换 → 计划中使用，保留整日芝麻油关联', () => {
    const j = get('MS-A-0901-L|芝麻');
    expect(j.state).toBe('PLANNED_USE');
    // 计划线索与领料线索都在（替换范围未登记，不删除整日关联）
    expect(j.paths.some((p) => p.level === 'PLANNED')).toBe(true);
    expect(j.paths.some((p) => p.level === 'INDIRECT' && p.links[0].materialId === 'REQ-A-0901-SES')).toBe(true);
    expect(j.gaps.join('|')).toContain('范围未登记');
    // 葵花籽油的“芝麻未检出”声明是相反记录，但范围是商品批次，不与计划线索冲突
    expect(j.opposites.some((o) => o.materialId === 'DEC-OIL-SUN-1')).toBe(true);
    expect(j.conflicts).toHaveLength(0);
    // 缺口：2 号锅无实际投料记录
    expect(j.gaps.join('|')).toContain('POT-A2');
  });

  it('标签提示可能含有：葵花籽油共用产线 → 花生为 LABEL_MAY_CONTAIN', () => {
    const j = get('MS-A-0901-L|花生');
    expect(j.state).toBe('LABEL_MAY_CONTAIN');
    const may = j.paths.find((p) => p.level === 'MAY_CONTAIN')!;
    expect(may.complete).toBe(true);
    expect(may.links[0].materialId).toBe('DEC-OIL-SUN-2');
  });

  it('场景2 只领料未投料：领料进厨房不证明投进每锅 → 间接线索', () => {
    const j = get('MS-B-0901-D|甲壳类');
    expect(j.state).toBe('INDIRECT_CLUE');
    expect(j.paths).toHaveLength(1);
    expect(j.paths[0].links[0].materialId).toBe('REQ-B-0901D-SHR');
    expect(j.paths[0].gapNote).toContain('不证明投进每锅');
  });

  it('场景3 同源转抄：厨房日报与窗口汇总引用同一领料单，不升级为多方证实', () => {
    const j = get('MS-B-0902-L|鱼');
    expect(j.state).toBe('CONFIRMED_PRESENT');
    expect(j.independentSupport).toBe(1); // 直接支持只有声明一条独立根
    expect(j.transcriptionCount).toBe(2); // 两条转抄同源
    const roots = j.paths.filter((p) => p.links[0].kind === 'TRANSCRIPTION').map((p) => p.supportRoots);
    expect(roots).toEqual([['REQ-B-0902-SAL'], ['REQ-B-0902-SAL']]);
  });

  it('场景6 循环引用：独立原件路径成立，循环自身不产生事实支持', () => {
    const j = get('MS-A-0901-D|芝麻');
    expect(j.state).toBe('CONFIRMED_PRESENT');
    const cyclePaths = j.paths.filter((p) => p.cycleBlocked);
    expect(cyclePaths.length).toBe(2); // NOTE-KITCHEN-A ↔ SUM-WINDOW-A
    cyclePaths.forEach((p) => expect(p.supportRoots).toEqual([]));
    // 独立原件：声明 DEC-SESAME-A1
    const direct = j.paths.find((p) => p.level === 'CONFIRMED')!;
    expect(direct.supportRoots).toEqual(['DEC-SESAME-A1']);
  });

  it('仅循环引用的成分 → 资料不足（循环不能产生事实支持）', () => {
    const j = get('MS-A-0901-D|花生');
    expect(j.state).toBe('INSUFFICIENT');
    expect(j.paths.every((p) => p.cycleBlocked)).toBe(true);
    expect(j.explanation.join('|')).toContain('不证明不含');
  });

  it('场景7 相反记录范围不重叠：不同锅次不同批次不误判为冲突', () => {
    const j = get('MS-A-0902-L|甲壳类');
    expect(j.state).toBe('CONFIRMED_PRESENT');
    expect(j.conflicts).toHaveLength(0);
    // POT-A32 的未检出声明按范围保留为相反记录
    const opp = j.opposites.find((o) => o.materialId === 'DEC-SHRIMP-2')!;
    expect(opp.scopeKey).toBe('product:6901001000086|SH-0902');
    expect(j.explanation.join('|')).toContain('范围不重叠');
  });

  it('场景8 同范围冲突：投料+声明 与 同锅未投料记录并存，双方原件并列不投票', () => {
    const j = get('MS-B-0901-L|蛋');
    expect(j.state).toBe('CONFLICT');
    expect(j.conflicts).toHaveLength(1);
    const c = j.conflicts[0];
    expect(c.scopeKey).toBe('pot:POT-B11|蛋');
    expect(c.supportMaterialIds).toContain('DEC-EGG-B1');
    expect(c.supportMaterialIds).toContain('INPUT-B11');
    expect(c.oppositeMaterialIds).toEqual(['NON-B11']);
    expect(c.note).toContain('不按到达时间或来源数量投票');
  });

  it('确认含有需要完整链路：投料+声明+批次+发餐；发餐合并不按整餐份数计暴露', () => {
    const j = get('MS-A-0901-B|乳');
    expect(j.state).toBe('CONFIRMED_PRESENT');
    expect(j.independentSupport).toBe(2); // DEC-MILK-A1 与 DEC-MILK-A2 独立
    expect(j.servingScope.attributableServingIds.sort()).toEqual(['SV-004', 'SV-005', 'SV-024']);
    expect(j.servingScope.mergedServings).toBe(0);
  });

  it('反向依赖索引覆盖路径与相反记录中的每个材料', () => {
    expect(derivation.reverseIndex['DEC-MILK-A1']).toEqual(['MS-A-0901-B|乳']);
    expect(derivation.reverseIndex['SUB-A-OIL']).toContain('MS-A-0901-L|芝麻');
    expect(derivation.reverseIndex['NON-B11']).toEqual(['MS-B-0901-L|蛋']);
    expect(derivation.reverseIndex['REQ-B-0901D-SHR']).toEqual(['MS-B-0901-D|甲壳类']);
  });
});

describe('撤回后的结论维护', () => {
  it('场景4 两条独立支持撤回其一：结论保留并说明保留原因', () => {
    const { store: s2, derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'WITHDRAW',
      materialId: 'DEC-MILK-A1',
      note: '供应商撤回该成分表',
    });
    const j = d2.judgments.find((x) => x.judgmentId === 'MS-A-0901-B|乳')!;
    expect(j.state).toBe('CONFIRMED_PRESENT');
    expect(j.independentSupport).toBe(1);
    expect(j.paths.some((p) => p.links[0].materialId === 'DEC-MILK-A2')).toBe(true);
    expect(j.paths.every((p) => p.links[0].materialId !== 'DEC-MILK-A1')).toBe(true);
    // 撤回材料保留身份与原始行（可追溯）
    const withdrawn = effectiveMaterials(s2).find((m) => m.materialId === 'DEC-MILK-A1')!;
    expect(withdrawn.status).toBe('WITHDRAWN');
    // 定向重算与全量重算一致
    const check = verifyAgainstFullRecompute(d2, s2, evidence, sessions, NOW);
    expect(check.mismatches).toEqual([]);
    expect(check.consistent).toBe(true);
  });

  it('场景5 最后一条支持撤回：转为资料不足，不沿用已确认标签，也不证明相反结论', () => {
    const { store: s2, derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'WITHDRAW',
      materialId: 'DEC-MILK-B1',
      note: '供应商更正：该批次声明作废',
    });
    const j = d2.judgments.find((x) => x.judgmentId === 'MS-B-0901-B|乳')!;
    expect(j.state).toBe('INSUFFICIENT');
    expect(j.explanation.join('|')).toContain('不证明不含');
    expect(j.explanation.join('|')).not.toContain('不含乳');
    // 统计中未知数 +1，已确认 -1
    const before = countStates(derivation.judgments);
    const after = countStates(d2.judgments);
    expect(after.CONFIRMED_PRESENT).toBe(before.CONFIRMED_PRESENT - 1);
    expect(after.INSUFFICIENT).toBe(before.INSUFFICIENT + 1);
    const check = verifyAgainstFullRecompute(d2, s2, evidence, sessions, NOW);
    expect(check.consistent).toBe(true);
  });

  it('撤回只影响反向依赖命中的判断，其他判断原样保留', () => {
    const { derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'WITHDRAW',
      materialId: 'DEC-MILK-B1',
      note: '',
    });
    const untouched = d2.judgments.find((x) => x.judgmentId === 'MS-A-0901-D|芝麻')!;
    expect(untouched.state).toBe('CONFIRMED_PRESENT');
    expect(untouched).toEqual(get('MS-A-0901-D|芝麻'));
  });
});

describe('更正适用范围与补证', () => {
  it('更正替换范围为指定锅次：不删除整日芝麻油关联，计划线索仍成立', () => {
    const { store: s2, derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'RECTIFY_SCOPE',
      materialId: 'SUB-A-OIL',
      note: '厨房确认仅 1 号锅改用葵花籽油',
      newScope: { scopeType: 'POTS', potIds: ['POT-A1'], fullReplacement: true },
    });
    const j = d2.judgments.find((x) => x.judgmentId === 'MS-A-0901-L|芝麻')!;
    expect(j.state).toBe('PLANNED_USE'); // 2 号锅计划线索仍成立
    expect(j.opposites.some((o) => o.scopeKey === 'pot:POT-A1|芝麻')).toBe(true);
    expect(j.gaps.join('|')).toContain('全量替换');
    const check = verifyAgainstFullRecompute(d2, s2, evidence, sessions, NOW);
    expect(check.consistent).toBe(true);
  });

  it('补证预览：导入 2 号锅芝麻油投料记录前，先看到受影响的餐次/成分/数量', () => {
    const preview = previewImpact(
      seed,
      derivation,
      { type: 'IMPORT_SUPPLEMENT', batchId: 'ev-supp-1' },
      evidence,
      sessions,
      NOW,
      nextCorrectionId(),
    );
    expect(preview.affectedJudgments).toHaveLength(1);
    const t = preview.affectedJudgments[0];
    expect(t.judgmentId).toBe('MS-A-0901-L|芝麻');
    expect(t.before).toBe('PLANNED_USE');
    expect(t.after).toBe('CONFIRMED_PRESENT');
    expect(preview.countsAfter.CONFIRMED_PRESENT).toBe(preview.countsBefore.CONFIRMED_PRESENT + 1);
    expect(preview.countsAfter.PLANNED_USE).toBe(preview.countsBefore.PLANNED_USE - 1);
    expect(preview.baseMaterialRevision).toBe(1);
  });

  it('补证提交：合并发餐确认存在含有记录，但不按整餐 5 份计暴露', () => {
    const { store: s2, derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'IMPORT_SUPPLEMENT',
      batchId: 'ev-supp-1',
    });
    const j = d2.judgments.find((x) => x.judgmentId === 'MS-A-0901-L|芝麻')!;
    expect(j.state).toBe('CONFIRMED_PRESENT');
    // 确认路径：补证的投料 + 芝麻油声明 + 锅次 + 合并发餐
    const direct = j.paths.find((p) => p.level === 'CONFIRMED')!;
    expect(direct.links.map((l) => l.materialId)).toEqual(['DEC-OIL-SES-1', 'INPUT-A-L2', 'POT-A2', 'DEST-A-L1']);
    // 合并发餐 5 份无逐份去向：可归属 0 份，不把整餐份数当已确认暴露
    expect(j.servingScope.mergedServings).toBe(5);
    expect(j.servingScope.attributableServingIds).toEqual([]);
    expect(j.servingScope.note).toContain('不代表所有份数');
    // 与葵花籽油的“芝麻未检出”范围不重叠，不构成冲突
    expect(j.conflicts).toHaveLength(0);
    const check = verifyAgainstFullRecompute(d2, s2, evidence, sessions, NOW);
    expect(check.consistent).toBe(true);
  });

  it('更正后的同批资料完整重算：定向更新无遗漏、无留下无依据的确认结果', () => {
    // 连续变更：更正范围 → 导入补证 → 撤回一份声明 → 撤回另一份声明
    let s = seed;
    let d = derivation;
    const changes: EvidenceChange[] = [
      { type: 'RECTIFY_SCOPE', materialId: 'SUB-A-OIL', note: '仅 1 号锅', newScope: { scopeType: 'POTS', potIds: ['POT-A1'], fullReplacement: true } },
      { type: 'IMPORT_SUPPLEMENT', batchId: 'ev-supp-1' },
      { type: 'WITHDRAW', materialId: 'DEC-MILK-A1', note: '撤回' },
      { type: 'WITHDRAW', materialId: 'DEC-MILK-B1', note: '撤回' },
    ];
    for (const c of changes) {
      const r = applyAndUpdate(s, d, c);
      s = r.store;
      d = r.derivation;
    }
    const check = verifyAgainstFullRecompute(d, s, evidence, sessions, NOW);
    expect(check.mismatches).toEqual([]);
    expect(check.consistent).toBe(true);
    // 无依据的确认结果不存在：每个已确认判断都至少有一条完整直接支持路径
    d.judgments
      .filter((j) => j.state === 'CONFIRMED_PRESENT')
      .forEach((j) => {
        expect(j.paths.some((p) => p.level === 'CONFIRMED' && p.complete)).toBe(true);
      });
    // 被撤回两份声明后，MS-B-0901-B 的乳为资料不足
    expect(d.judgments.find((j) => j.judgmentId === 'MS-B-0901-B|乳')!.state).toBe('INSUFFICIENT');
    // MS-A-0901-B 的乳仍由 DEC-MILK-A2 独立支持
    expect(d.judgments.find((j) => j.judgmentId === 'MS-A-0901-B|乳')!.state).toBe('CONFIRMED_PRESENT');
  });
});

describe('引用图与快照', () => {
  it('支持根解析：转抄归并到同一原件，循环被识别', () => {
    const byIdMap = new Map(effectiveMaterials(seed).map((m) => [m.materialId, m]));
    expect(supportRootsOf('SUM-B-W2', byIdMap).roots).toEqual(['REQ-B-0902-SAL']);
    const cyc = supportRootsOf('NOTE-KITCHEN-A', byIdMap);
    expect(cyc.cycleBlocked).toBe(true);
    expect(cyc.roots).toEqual([]);
    expect(countIndependentSupports([['A'], ['A', 'B'], ['B'], ['C']])).toBe(2);
  });

  it('推导运行快照保留当时解释，材料后续变化不改写旧运行', () => {
    const run1 = snapshotRun(derivation, seed, 'EVRUN-1', '初始种子推导', NOW);
    const { store: s2, derivation: d2 } = applyAndUpdate(seed, derivation, {
      type: 'WITHDRAW',
      materialId: 'DEC-MILK-B1',
      note: '撤回',
    });
    const run2 = snapshotRun(d2, s2, 'EVRUN-2', '撤回 DEC-MILK-B1', NOW);
    const inRun1 = run1.judgments.find((j) => j.judgmentId === 'MS-B-0901-B|乳')!;
    const inRun2 = run2.judgments.find((j) => j.judgmentId === 'MS-B-0901-B|乳')!;
    expect(inRun1.state).toBe('CONFIRMED_PRESENT'); // 旧运行保持当时解释
    expect(inRun2.state).toBe('INSUFFICIENT');
    expect(run1.stats.CONFIRMED_PRESENT).toBe(run2.stats.CONFIRMED_PRESENT + 1);
    expect(run2.correctionsApplied).toHaveLength(1);
  });
});

describe('导出与统计口径', () => {
  it('导出固定引用运行快照：六态口径、完整判断与免责声明', () => {
    const run = snapshotRun(derivation, seed, 'EVRUN-EXP', '导出测试', NOW);
    const ex = buildEvidenceExport(run, NOW);
    expect(ex.exportKind).toBe('allergen-evidence-derivation');
    expect(ex.runId).toBe('EVRUN-EXP');
    expect(ex.judgments).toHaveLength(10);
    expect(ex.caliberSummary.INSUFFICIENT).toContain('不等于不含');
    expect(ex.disclaimer).toContain('不得据此作出「无过敏原」结论');
    expect(ex.disclaimer).toContain('不作食物安全放行或医疗诊断');
    // 统计与导出同源：stats 与判断明细一致
    const recount = countStates(ex.judgments);
    expect(ex.stats).toEqual(recount);
  });

  it('CSV 明细与推导结果同源（每判断一行）', () => {
    const run = snapshotRun(derivation, seed, 'EVRUN-CSV', 'csv', NOW);
    const csv = judgmentsToCsv(run.judgments);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(11); // 表头 + 10 判断
    expect(csv).toContain('MS-A-0901-L');
    expect(csv).toContain('材料冲突');
  });
});
