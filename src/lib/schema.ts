import type { BatchMeta, FieldStatus, SourceType } from '../types';

/** 各来源的主键字段与业务字段约定，用于字段四态检查与质量检查 */
export interface SourceSchema {
  sourceType: SourceType;
  label: string;
  keyFields: string[];
  /** 期望存在的业务字段（用于区分“源文件未提供”与“值为空”） */
  expectedFields: string[];
}

export const SOURCE_SCHEMAS: Record<SourceType, SourceSchema> = {
  supplier_items: {
    sourceType: 'supplier_items',
    label: '供应商成分',
    keyFields: ['supplier_code'],
    expectedFields: ['supplier_code', 'product_name', 'spec', 'unit', 'allergens_declared', 'cert_no', 'updated_at'],
  },
  recipes: {
    sourceType: 'recipes',
    label: '菜谱',
    keyFields: ['recipe_id', 'ingredient_seq'],
    expectedFields: ['recipe_id', 'ingredient_seq', 'ingredient_name', 'planned_qty', 'unit', 'planned_date'],
  },
  kitchen_usage: {
    sourceType: 'kitchen_usage',
    label: '厨房实际用料',
    keyFields: ['usage_id'],
    expectedFields: ['usage_id', 'usage_date', 'kitchen_alias', 'qty', 'unit', 'window', 'status', 'recipe_id'],
  },
  meal_sessions: {
    sourceType: 'meal_sessions',
    label: '餐次日志',
    keyFields: ['session_id'],
    expectedFields: ['session_id', 'school_id', 'serving_date', 'window', 'start_time', 'end_time', 'recipe_id'],
  },
  meal_servings: {
    sourceType: 'meal_servings',
    label: '学生领餐',
    keyFields: ['serving_id'],
    expectedFields: ['serving_id', 'student_anon_id', 'session_id', 'served_at'],
  },
  diet_restrictions: {
    sourceType: 'diet_restrictions',
    label: '饮食限制',
    keyFields: ['studentAnonId'],
    expectedFields: ['studentAnonId', 'schoolId', 'avoidAllergens', 'effectiveFrom', 'effectiveTo'],
  },
};

export const FIELD_STATUS_LABEL: Record<FieldStatus, string> = {
  OK: '正常',
  FIELD_NOT_PROVIDED: '源文件未提供该字段',
  VALUE_EMPTY: '字段值为空',
  REF_NOT_FOUND: '关联对象不存在',
  BATCH_PENDING: '来源批次尚未到齐',
};

export const BATCH_LABEL = (meta: BatchMeta): string =>
  `${SOURCE_SCHEMAS[meta.sourceType].label} · ${meta.schoolId === '*' ? '全校' : meta.schoolId + '校'} · ${meta.dataDate}`;
