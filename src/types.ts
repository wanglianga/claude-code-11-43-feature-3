// 领域类型定义：所有分析结果均由输入数据 + 映射 + 规则版本派生

export type SourceType =
  | 'supplier_items'
  | 'recipes'
  | 'kitchen_usage'
  | 'meal_sessions'
  | 'meal_servings'
  | 'diet_restrictions';

export type BatchStatus = 'ARRIVED' | 'PENDING';

export interface BatchMeta {
  batchId: string;
  sourceType: SourceType;
  schoolId: string;
  fileName: string;
  dataDate: string;
  updatedAt: string | null;
  expectedRows: number;
  status: BatchStatus;
  notes?: string;
}

export interface Manifest {
  manifestVersion: string;
  generatedAt: string;
  mealWindows: MealWindow[];
  batches: BatchMeta[];
}

export interface MealWindow {
  schoolId: string;
  window: string;
  start: string;
  end: string;
}

/** 解析后的原始行：保留行号与原始字段，便于下钻 */
export interface RawRow {
  rowId: string; // batchId + '#' + 行号
  batchId: string;
  lineNo: number;
  values: Record<string, string>;
}

export interface LoadedBatch {
  meta: BatchMeta;
  headers: string[];
  rows: RawRow[];
  /** 输入文件内容哈希（运行固定引用，防止静默改写） */
  fileHash: string;
}

export interface StandardIngredient {
  stdId: string;
  name: string;
  category: string;
  allergens: string[];
  baseUnit: string;
}

export type MappingDecision = 'APPROVED_ALIAS' | 'CONFIRMED' | 'REJECTED' | 'CANDIDATE';

export interface SupplierMappingEntry {
  schoolId: string;
  supplierCode: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface KitchenMappingEntry {
  schoolId: string;
  kitchenAlias: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface StudentSessionMappingEntry {
  studentAnonId: string;
  sessionId: string;
  decision: MappingDecision;
  note?: string;
}

export interface MappingDocument {
  mappingVersion: string;
  ruleVersion: string;
  updatedAt: string;
  supplierMappings: SupplierMappingEntry[];
  kitchenMappings: KitchenMappingEntry[];
  studentSessionMappings: StudentSessionMappingEntry[];
}

/** 映射保存时的乐观锁包装 */
export interface MappingState {
  doc: MappingDocument;
  /** 单调递增版本号，保存冲突检测用 */
  revision: number;
  lastModifiedAt: string;
}

// ---------- 质量检查 ----------

export type QualityIssueType =
  | 'DUPLICATE_KEY'
  | 'MISSING_KEY'
  | 'UNIT_CONFLICT'
  | 'TIME_UNASSIGNABLE'
  | 'MANY_TO_MANY';

export interface QualityIssue {
  type: QualityIssueType;
  batchId: string;
  rowIds: string[];
  field: string;
  message: string;
  detail?: Record<string, string | number>;
}

/** 字段四态：源文件未提供 / 值为空 / 关联对象不存在 / 批次未到齐 */
export type FieldStatus =
  | 'FIELD_NOT_PROVIDED'
  | 'VALUE_EMPTY'
  | 'REF_NOT_FOUND'
  | 'BATCH_PENDING'
  | 'OK';

export interface FieldCheck {
  batchId: string;
  field: string;
  status: FieldStatus;
  count: number;
  rowIds: string[];
}

// ---------- 匹配与候选 ----------

export type MatchKind = 'EXACT_CODE' | 'APPROVED_ALIAS' | 'CONFIRMED' | 'CANDIDATE' | 'UNMATCHED';

export interface MatchCandidate {
  target: string; // 被匹配的键（供应商编码 / 厨房简称）
  stdId: string;
  score: number;
  reasons: string[];
}

export interface MatchResolution {
  scope: string; // schoolId 或 *
  sourceKey: string;
  kind: MatchKind;
  stdId: string | null;
  candidates: MatchCandidate[];
  evidenceRowIds: string[];
}

// ---------- 分析运行 ----------

export type EvidenceBucket = 'CONFIRMED' | 'CANDIDATE_PENDING' | 'UNKNOWN_MISSING';

export interface ServingAssessment {
  servingId: string;
  studentAnonId: string;
  sessionId: string;
  schoolId: string;
  servedAt: string;
  window: string;
  recipeId: string;
  bucket: EvidenceBucket;
  /** 实际参与计算的厨房用料行（仅 ACTUAL 且已解析到标准原料） */
  usageRowIds: string[];
  allergensConfirmed: string[];
  restrictionAllergens: string[];
  exposedConfirmed: string[];
  unknownReasons: string[];
  trace: TraceStep[];
}

export interface TraceStep {
  stage: string;
  decision: string;
  ref: string;
}

export interface CoverageCounts {
  total: number;
  confirmed: number;
  candidatePending: number;
  unknownMissing: number;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  inputHashes: Record<string, string>;
  mappingVersion: string;
  mappingRevision: number;
  ruleVersion: string;
  scopeBatchIds: string[];
  coverage: CoverageCounts;
  confirmedExposures: number;
  confirmedSafe: number;
  unknownReasonsBreakdown: Record<string, number>;
  qualityIssueCounts: Record<QualityIssueType, number>;
}

export interface AnalysisRun {
  summary: RunSummary;
  assessments: ServingAssessment[];
  qualityIssues: QualityIssue[];
  fieldChecks: FieldCheck[];
  resolutions: MatchResolution[];
  metricDetails: MetricDetail[];
}

export interface MetricDetail {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  exclusions: string[];
  sourceScope: string[];
  explanation: string;
}

export interface RunDiff {
  baseRunId: string;
  targetRunId: string;
  changedServingBuckets: Record<EvidenceBucket, Record<EvidenceBucket, number>>;
  coverageBefore: CoverageCounts;
  coverageAfter: CoverageCounts;
  changedServingIds: string[];
  newIssues: QualityIssue[];
  resolvedIssues: QualityIssue[];
}
