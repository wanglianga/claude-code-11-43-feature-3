// 浏览器端证据数据集加载（与主数据集并列的独立清单，不干扰既有引擎）
import { DATA_BASE } from '../lib/loadDataset';
import { parseCsv } from '../lib/csv';
import { sha256 } from '../lib/hash';
import type { RawRow } from '../types';
import { materialsFromRows } from './materials';
import type { SessionInfo } from './derive';
import type { EvidenceDataset, EvidenceMaterial } from './types';

/** 从主数据集餐次日志行提取推导所需餐次信息（沿用主服务已有的餐次对应） */
export function sessionsFromRows(rows: RawRow[]): SessionInfo[] {
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  for (const r of rows) {
    const id = r.values.session_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      sessionId: id,
      schoolId: r.values.school_id,
      servingDate: r.values.serving_date,
      window: r.values.window,
      recipeId: r.values.recipe_id,
    });
  }
  return out;
}

async function fetchText(path: string): Promise<string> {
  const resp = await fetch(`${DATA_BASE}/${path}`);
  if (!resp.ok) throw new Error(`无法加载证据材料文件 ${path}: HTTP ${resp.status}`);
  return resp.text();
}

export async function loadEvidenceDataset(): Promise<EvidenceDataset> {
  const manifestText = await fetchText('evidence/manifest.json');
  const manifest: EvidenceDataset['manifest'] = JSON.parse(manifestText);
  const ingredientMapJson = JSON.parse(await fetchText('evidence/ingredient_map.json')) as {
    map: Record<string, string[]>;
  };

  const seedMaterials: EvidenceMaterial[] = [];
  const rowsByBatch: Record<string, RawRow[]> = {};
  const hashes: Record<string, string> = { manifest: await sha256(manifestText) };

  for (const meta of manifest.batches) {
    const text = await fetchText(meta.fileName);
    hashes[meta.batchId] = await sha256(text);
    const { rows } = parseCsv(text, meta.batchId);
    rowsByBatch[meta.batchId] = rows;
    const supplement = meta.status === 'SUPPLEMENT';
    // 补证批次与正式批次分开标记；是否进入推导由材料库的 importedSupplements 决定
    seedMaterials.push(...materialsFromRows(meta.kind, meta.batchId, '*', rows, supplement));
  }

  return {
    manifest,
    ingredientMap: ingredientMapJson.map,
    seedMaterials,
    rowsByBatch,
    hashes,
  };
}
