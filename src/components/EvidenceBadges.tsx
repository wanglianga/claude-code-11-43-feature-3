import type { DeclarationKind, JudgmentState, MaterialKind, PathLevel } from '../evidence/types';
import { DECLARATION_LABEL, JUDGMENT_STATE_LABEL, MATERIAL_KIND_LABEL, PATH_LEVEL_LABEL } from '../evidence/types';

const STATE_CLASS: Record<JudgmentState, string> = {
  CONFIRMED_PRESENT: 'confirmed',
  LABEL_MAY_CONTAIN: 'maybe',
  PLANNED_USE: 'planned',
  INDIRECT_CLUE: 'candidate',
  INSUFFICIENT: 'unknown',
  CONFLICT: 'issue',
};

/** 六态判断徽标：分别表达，不折叠成可信分数 */
export function JudgmentBadge({ state }: { state: JudgmentState }) {
  return <span className={`badge ${STATE_CLASS[state]}`}>{JUDGMENT_STATE_LABEL[state]}</span>;
}

const LEVEL_CLASS: Record<PathLevel, string> = {
  CONFIRMED: 'confirmed',
  MAY_CONTAIN: 'maybe',
  PLANNED: 'planned',
  INDIRECT: 'candidate',
};

export function PathLevelBadge({ level }: { level: PathLevel }) {
  return <span className={`badge ${LEVEL_CLASS[level]}`}>{PATH_LEVEL_LABEL[level]}</span>;
}

export function MaterialKindBadge({ kind }: { kind: MaterialKind }) {
  return <span className="badge neutral">{MATERIAL_KIND_LABEL[kind]}</span>;
}

const DECL_CLASS: Record<DeclarationKind, string> = {
  CONTAINS: 'issue',
  MAY_CONTAIN: 'maybe',
  NOT_DETECTED: 'ok',
};

export function DeclarationBadge({ kind }: { kind: DeclarationKind }) {
  return <span className={`badge ${DECL_CLASS[kind]}`}>{DECLARATION_LABEL[kind]}</span>;
}
