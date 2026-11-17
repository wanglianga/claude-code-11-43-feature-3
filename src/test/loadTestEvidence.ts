// 测试用证据数据集加载：与 src/evidence/loadEvidence.ts 的浏览器逻辑保持一致
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { sha256 } from '../lib/hash';
import { materialsFromRows } from '../evidence/materials';
import type { EvidenceDataset, EvidenceMaterial } from '../evidence/types';
import type { RawRow } from '../types';

const ROOT = join(__dirname, '..', '..', 'public', 'sample-data');

function text(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

export async function loadTestEvidence(): Promise<EvidenceDataset> {
  const manifestText = text('evidence/manifest.json');
  const manifest: EvidenceDataset['manifest'] = JSON.parse(manifestText);
  const ingredientMapJson = JSON.parse(text('evidence/ingredient_map.json')) as {
    map: Record<string, string[]>;
  };

  const seedMaterials: EvidenceMaterial[] = [];
  const rowsByBatch: Record<string, RawRow[]> = {};
  const hashes: Record<string, string> = { manifest: await sha256(manifestText) };

  for (const meta of manifest.batches) {
    const raw = text(meta.fileName);
    hashes[meta.batchId] = await sha256(raw);
    const { rows } = parseCsv(raw, meta.batchId);
    rowsByBatch[meta.batchId] = rows;
    seedMaterials.push(
      ...materialsFromRows(meta.kind, meta.batchId, '*', rows, meta.status === 'SUPPLEMENT'),
    );
  }

  return { manifest, ingredientMap: ingredientMapJson.map, seedMaterials, rowsByBatch, hashes };
}
