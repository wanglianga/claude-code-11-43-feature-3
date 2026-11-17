import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverageBar, CoverageDonut } from './Coverage';
import { BucketBadge, MatchBadge, FieldStatusBadge } from './Badges';
import { JudgmentBadge, PathLevelBadge } from './EvidenceBadges';
import type { CoverageCounts } from '../types';

const coverage: CoverageCounts = { total: 24, confirmed: 4, candidatePending: 1, unknownMissing: 19 };

describe('展示组件渲染冒烟（Node SSR）', () => {
  it('覆盖条与环形图按三桶数据渲染', () => {
    const bar = renderToStaticMarkup(<CoverageBar coverage={coverage} />);
    expect(bar).toContain('seg-confirmed');
    expect(bar).toContain('共 24 条领餐');
    const donut = renderToStaticMarkup(<CoverageDonut coverage={coverage} />);
    expect(donut).toContain('conic-gradient');
    expect(donut).toContain('来源缺失未知（19');
  });

  it('三类徽标渲染正确文案', () => {
    expect(renderToStaticMarkup(<BucketBadge bucket="CONFIRMED" />)).toContain('有证据支持的匹配');
    expect(renderToStaticMarkup(<BucketBadge bucket="CANDIDATE_PENDING" />)).toContain('存在候选但需确认');
    expect(renderToStaticMarkup(<BucketBadge bucket="UNKNOWN_MISSING" />)).toContain('来源缺失无法判定');
    expect(renderToStaticMarkup(<MatchBadge kind="APPROVED_ALIAS" />)).toContain('已批准别名');
    expect(renderToStaticMarkup(<FieldStatusBadge status="BATCH_PENDING" />)).toContain('来源批次尚未到齐');
  });

  it('证据六态徽标分别表达，不混成同一分数', () => {
    expect(renderToStaticMarkup(<JudgmentBadge state="CONFIRMED_PRESENT" />)).toContain('实际批次已确认含有');
    expect(renderToStaticMarkup(<JudgmentBadge state="LABEL_MAY_CONTAIN" />)).toContain('标签提示可能含有');
    expect(renderToStaticMarkup(<JudgmentBadge state="PLANNED_USE" />)).toContain('计划中使用');
    expect(renderToStaticMarkup(<JudgmentBadge state="INDIRECT_CLUE" />)).toContain('有间接线索');
    expect(renderToStaticMarkup(<JudgmentBadge state="INSUFFICIENT" />)).toContain('资料不足');
    expect(renderToStaticMarkup(<JudgmentBadge state="CONFLICT" />)).toContain('材料冲突');
    expect(renderToStaticMarkup(<PathLevelBadge level="CONFIRMED" />)).toContain('直接支持');
  });
});
