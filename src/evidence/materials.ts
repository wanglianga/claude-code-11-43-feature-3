// 材料层：从原始行构建证据材料、应用更正记录（撤回/更正范围）
import type { RawRow } from '../types';
import type {
  CorrectionRecord,
  EvidenceMaterial,
  MaterialKind,
  MaterialScope,
} from './types';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把一批原始行解析为证据材料（纯函数，浏览器与测试加载器共用） */
export function materialsFromRows(
  kind: MaterialKind,
  batchId: string,
  schoolId: string,
  rows: RawRow[],
  supplement: boolean,
): EvidenceMaterial[] {
  return rows.map((row) => {
    const v = row.values;
    const base = {
      materialId: v.material_id,
      kind,
      batchId,
      rowId: row.rowId,
      // 行内 school_id 优先（领料单等按行归属学校），否则用批次默认
      schoolId: v.school_id || schoolId,
      cites: splitList(v.cites),
      status: 'ACTIVE' as const,
      supplement,
    };
    let scope: MaterialScope = {};
    switch (kind) {
      case 'PLAN_RECIPE':
        scope = { sessionId: v.session_id };
        break;
      case 'REQUISITION':
        scope = {};
        break;
      case 'ACTUAL_INPUT':
        scope = { potIds: splitList(v.pot_id) };
        break;
      case 'PRODUCTION_BATCH':
        scope = { sessionId: v.session_id, potIds: splitList(v.pot_id) };
        break;
      case 'SUBSTITUTION':
        scope = {
          sessionId: v.session_id,
          scopeType: (v.scope_type || 'UNCLEAR') as MaterialScope['scopeType'],
          potIds: splitList(v.scope_pots),
          fullReplacement: v.full_replacement === 'YES',
        };
        break;
      case 'SERVING_DESTINATION':
        scope = { sessionId: v.session_id, potIds: splitList(v.pot_ids) };
        break;
      case 'PRODUCT_DECLARATION':
        scope = {
          formulaId: v.formula_id,
          productBatch: v.product_batch,
          validFrom: v.valid_from,
          validTo: v.valid_to,
        };
        break;
      case 'TRANSCRIPTION':
        scope = { sessionId: v.session_id };
        break;
    }
    return { ...base, scope, attrs: { ...v } };
  });
}

/**
 * 应用更正记录得到当前有效材料集：
 * - WITHDRAW：目标材料标记 WITHDRAWN（保留身份与原始行，可追溯）
 * - RECTIFY_SCOPE：替换该材料的有效范围（如把“范围未登记”的替换记录更正为指定锅次）
 */
export function applyCorrections(
  materials: EvidenceMaterial[],
  corrections: CorrectionRecord[],
): EvidenceMaterial[] {
  let out = materials.map((m) => ({ ...m, scope: { ...m.scope } }));
  for (const c of corrections) {
    if (c.type === 'WITHDRAW') {
      out = out.map((m) =>
        m.materialId === c.targetMaterialId
          ? { ...m, status: 'WITHDRAWN', withdrawnBy: c.correctionId }
          : m,
      );
    } else if (c.type === 'RECTIFY_SCOPE' && c.newScope) {
      out = out.map((m) =>
        m.materialId === c.targetMaterialId
          ? { ...m, scope: { ...m.scope, ...c.newScope } }
          : m,
      );
    }
  }
  return out;
}

/** 成分名称 → 成分键（过敏原）映射；未命中返回空数组（不构成任何证据） */
export function componentKeysOf(
  ingredientName: string,
  ingredientMap: Record<string, string[]>,
): string[] {
  return ingredientMap[ingredientName] ?? [];
}
