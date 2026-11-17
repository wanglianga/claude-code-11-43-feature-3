// 证据语义与推导类型：所有判断均由输入材料 + 更正记录实际生成，不用静态等级表

import type { RawRow } from '../types';

/** 七类输入材料 + 转抄材料（厨房日报/窗口汇总等派生文书） */
export type MaterialKind =
  | 'PLAN_RECIPE'
  | 'REQUISITION'
  | 'ACTUAL_INPUT'
  | 'PRODUCTION_BATCH'
  | 'SUBSTITUTION'
  | 'SERVING_DESTINATION'
  | 'PRODUCT_DECLARATION'
  | 'TRANSCRIPTION';

export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  PLAN_RECIPE: '计划配方',
  REQUISITION: '领料事实',
  ACTUAL_INPUT: '实际投料',
  PRODUCTION_BATCH: '制作分锅',
  SUBSTITUTION: '替换适用范围',
  SERVING_DESTINATION: '发餐去向',
  PRODUCT_DECLARATION: '商品成分声明',
  TRANSCRIPTION: '转抄材料',
};

/** 声明语义：含有 / 可能含有 / 明确未检出（空白、缺声明、未命中均不构成不含证据） */
export type DeclarationKind = 'CONTAINS' | 'MAY_CONTAIN' | 'NOT_DETECTED';

export const DECLARATION_LABEL: Record<DeclarationKind, string> = {
  CONTAINS: '声明含有',
  MAY_CONTAIN: '标签提示可能含有',
  NOT_DETECTED: '明确未检出',
};

/** 材料有效范围（按材料类型取用不同字段） */
export interface MaterialScope {
  sessionId?: string;
  potIds?: string[];
  /** 替换记录：POTS 指定锅次 / ALL_DAY 全日 / UNCLEAR 范围未登记 */
  scopeType?: 'POTS' | 'ALL_DAY' | 'UNCLEAR';
  fullReplacement?: boolean;
  formulaId?: string;
  productBatch?: string;
  validFrom?: string;
  validTo?: string;
}

/** 证据材料：保留身份、来源批次、有效范围、原始行与引用（转抄）关系 */
export interface EvidenceMaterial {
  materialId: string;
  kind: MaterialKind;
  batchId: string;
  rowId: string;
  schoolId: string;
  scope: MaterialScope;
  attrs: Record<string, string>;
  /** 本材料转抄/引用的上游材料 id（derivedFrom）；空数组表示原始材料 */
  cites: string[];
  status: 'ACTIVE' | 'WITHDRAWN';
  withdrawnBy?: string;
  /** 来自补证批次（默认不进入推导，导入后生效） */
  supplement?: boolean;
}

/** 更正记录：撤回材料 / 更正适用范围；只追加，不改写原材料行 */
export interface CorrectionRecord {
  correctionId: string;
  type: 'WITHDRAW' | 'RECTIFY_SCOPE';
  targetMaterialId: string;
  note: string;
  createdAt: string;
  /** RECTIFY_SCOPE 时的新范围 */
  newScope?: MaterialScope;
}

/** 材料库：已提交材料 + 单调递增修订号（跨标签页乐观锁） */
export interface MaterialStore {
  revision: number;
  materials: EvidenceMaterial[];
  corrections: CorrectionRecord[];
  /** 已导入的补证批次 */
  importedSupplements: string[];
  updatedAt: string;
}

// ---------- 推导结果 ----------

/** 六态判断：分别表达，不折叠成可信分数 */
export type JudgmentState =
  | 'CONFIRMED_PRESENT'
  | 'LABEL_MAY_CONTAIN'
  | 'PLANNED_USE'
  | 'INDIRECT_CLUE'
  | 'INSUFFICIENT'
  | 'CONFLICT';

export const JUDGMENT_STATE_LABEL: Record<JudgmentState, string> = {
  CONFIRMED_PRESENT: '实际批次已确认含有',
  LABEL_MAY_CONTAIN: '标签提示可能含有',
  PLANNED_USE: '计划中使用',
  INDIRECT_CLUE: '有间接线索',
  INSUFFICIENT: '资料不足',
  CONFLICT: '材料冲突',
};

export const JUDGMENT_STATE_ORDER: JudgmentState[] = [
  'CONFLICT',
  'CONFIRMED_PRESENT',
  'LABEL_MAY_CONTAIN',
  'PLANNED_USE',
  'INDIRECT_CLUE',
  'INSUFFICIENT',
];

/** 支持路径等级（CONFIRMED/MAY 需要完整链路；PLANNED/INDIRECT 为线索级） */
export type PathLevel = 'CONFIRMED' | 'MAY_CONTAIN' | 'PLANNED' | 'INDIRECT';

export const PATH_LEVEL_LABEL: Record<PathLevel, string> = {
  CONFIRMED: '直接支持（实际投料+声明+批次+发餐）',
  MAY_CONTAIN: '直接支持（声明为可能含有）',
  PLANNED: '计划线索',
  INDIRECT: '间接线索',
};

export interface PathLink {
  materialId: string;
  rowId: string;
  kind: MaterialKind;
  note: string;
}

/** 一条支持路径：完整链路或带缺口的链路；根原件用于区分独立支持与转抄 */
export interface SupportPath {
  pathId: string;
  level: PathLevel;
  complete: boolean;
  links: PathLink[];
  /** 终端主张材料的引用闭包叶节点（去转抄后的根原件） */
  supportRoots: string[];
  /** 循环引用阻断：循环自身不产生事实支持 */
  cycleBlocked: boolean;
  /** 缺口说明（如：领料进厨房但未投料、发餐去向缺失） */
  gapNote?: string;
  /** 该路径确认到的锅次 */
  potIds: string[];
}

/** 相反记录（明确未检出 / 未投料 / 全量替换），按范围与含有依据比对 */
export interface OppositeRecord {
  materialId: string;
  rowId: string;
  scopeKey: string;
  scopeLabel: string;
  note: string;
}

/** 同范围冲突：已确认含有依据与明确相反记录并存，双方原件并列，不按到达时间或来源数量投票 */
export interface ConflictPair {
  scopeKey: string;
  scopeLabel: string;
  supportMaterialIds: string[];
  oppositeMaterialIds: string[];
  note: string;
}

/** 发餐范围：合并发餐不能把整餐份数当成已确认暴露份数 */
export interface ServingScope {
  attributableServingIds: string[];
  mergedServings: number;
  note: string;
}

/** 单个（餐次 × 成分键）判断 */
export interface IngredientJudgment {
  judgmentId: string; // sessionId|key
  sessionId: string;
  componentKey: string;
  state: JudgmentState;
  paths: SupportPath[];
  opposites: OppositeRecord[];
  conflicts: ConflictPair[];
  gaps: string[];
  explanation: string[];
  servingScope: ServingScope;
  /** 独立支持数（按根原件去重；同源转抄不增加） */
  independentSupport: number;
  /** 转抄材料数（与某支持同源的派生文书） */
  transcriptionCount: number;
  materialRevision: number;
}

/** 推导库：保存全部判断、支持路径与反向依赖；材料变化时定向重算 */
export interface DerivationStore {
  derivationRevision: number;
  materialRevision: number;
  computedAt: string;
  judgments: IngredientJudgment[];
  /** 反向依赖：材料 id -> 受影响的判断 id（撤回/更正时定向重算） */
  reverseIndex: Record<string, string[]>;
}

/** 推导运行快照：不可变，保留当时解释，不被新证据静默替换 */
export interface EvidenceRun {
  runId: string;
  createdAt: string;
  note: string;
  materialRevision: number;
  derivationRevision: number;
  stats: Record<JudgmentState, number>;
  judgments: IngredientJudgment[];
  correctionsApplied: string[];
}

/** 补证/撤回/更正的影响预览（未提交） */
export interface ImpactPreviewResult {
  changeDescription: string;
  affectedJudgments: Array<{
    judgmentId: string;
    sessionId: string;
    componentKey: string;
    /** null 表示此前不存在该判断（新增） */
    before: JudgmentState | null;
    /** null 表示该判断随材料变化移除 */
    after: JudgmentState | null;
    reason: string;
  }>;
  countsBefore: Record<JudgmentState, number>;
  countsAfter: Record<JudgmentState, number>;
  /** 预览基于的材料修订号；提交时若已落后则拒绝 */
  baseMaterialRevision: number;
  previewedAt: string;
}

/** 推导用的原始行索引（下钻展示用） */
export interface EvidenceDataset {
  manifest: {
    evidenceManifestVersion: string;
    generatedAt: string;
    batches: Array<{
      batchId: string;
      kind: MaterialKind;
      fileName: string;
      dataDate: string;
      expectedRows: number;
      status: 'ARRIVED' | 'SUPPLEMENT';
      notes?: string;
    }>;
  };
  ingredientMap: Record<string, string[]>;
  /** 全部材料（含补证批次；补证材料 supplement=true 且默认未导入） */
  seedMaterials: EvidenceMaterial[];
  rowsByBatch: Record<string, RawRow[]>;
  hashes: Record<string, string>;
}
