// 证据推导导出：统计与导出使用同一份推导结果；内置防误读声明
import type { DerivationStore, EvidenceRun, JudgmentState } from '../evidence/types';
import { JUDGMENT_STATE_LABEL } from '../evidence/types';

export interface EvidenceExport {
  exportKind: 'allergen-evidence-derivation';
  exportedAt: string;
  runId: string;
  materialRevision: number;
  derivationRevision: number;
  caliberSummary: Record<JudgmentState, string>;
  stats: Record<JudgmentState, number>;
  judgments: EvidenceRun['judgments'];
  disclaimer: string;
}

const CALIBER: Record<JudgmentState, string> = {
  CONFIRMED_PRESENT: '实际投料 + 商品成分声明（含配方/批次）+ 发餐关系齐备，才计入已确认含有',
  LABEL_MAY_CONTAIN: '商品标签提示可能含有，按可能含有表达，不升级为已确认',
  PLANNED_USE: '计划配方使用，但无覆盖全部范围的实际投料记录；计划不能补成实际投料',
  INDIRECT_CLUE: '仅有间接线索（领料、缺声明的投料、转抄），领料进厨房不证明投进每锅',
  INSUFFICIENT: '资料不足：没有完整且适用的支持路径；不等于不含该成分，不能统计为无过敏原',
  CONFLICT: '同一范围内已确认含有依据与明确相反记录并存，双方原件并列，不按到达时间或来源数量投票',
};

/** 导出载荷固定引用某个不可变运行：统计与导出消费同一份推导结果 */
export function buildEvidenceExport(run: EvidenceRun, exportedAt: string): EvidenceExport {
  return {
    exportKind: 'allergen-evidence-derivation',
    exportedAt,
    runId: run.runId,
    materialRevision: run.materialRevision,
    derivationRevision: run.derivationRevision,
    caliberSummary: CALIBER,
    stats: run.stats,
    judgments: run.judgments,
    disclaimer:
      '本文件中的「资料不足/未知」表示当前材料缺少证据，不等于该餐次确认不含该成分；接收方不得据此作出「无过敏原」结论。本结果不作食物安全放行或医疗诊断用途。',
  };
}

export function judgmentsToCsv(judgments: DerivationStore['judgments']): string {
  const header = [
    'session_id',
    'component_key',
    'state',
    'independent_support',
    'transcription_count',
    'paths',
    'opposites',
    'conflicts',
    'merged_servings',
    'attributable_servings',
    'gaps',
  ];
  const lines = [header.join(',')];
  judgments.forEach((j) => {
    lines.push(
      [
        j.sessionId,
        j.componentKey,
        JUDGMENT_STATE_LABEL[j.state],
        String(j.independentSupport),
        String(j.transcriptionCount),
        String(j.paths.length),
        String(j.opposites.length),
        String(j.conflicts.length),
        String(j.servingScope.mergedServings),
        String(j.servingScope.attributableServingIds.length),
        j.gaps.join('；'),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
  });
  return '﻿' + lines.join('\n');
}
