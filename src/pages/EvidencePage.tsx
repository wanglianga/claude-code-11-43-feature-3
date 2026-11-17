import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { useEvidenceState } from '../state/EvidenceState';
import { Drawer, RawRowView } from '../components/Drawer';
import { JudgmentBadge, MaterialKindBadge, PathLevelBadge } from '../components/EvidenceBadges';
import { effectiveMaterials, countStates, type EvidenceChange } from '../evidence/store';
import {
  JUDGMENT_STATE_LABEL,
  JUDGMENT_STATE_ORDER,
  type EvidenceDataset,
  type EvidenceMaterial,
  type EvidenceRun,
  type IngredientJudgment,
} from '../evidence/types';
import { buildEvidenceExport, judgmentsToCsv } from '../lib/evidenceExport';
import { downloadCsv, downloadJson } from '../lib/export';
import type { RawRow } from '../types';

type TabKey = 'sessions' | 'materials' | 'preview' | 'runs';

export function EvidencePage() {
  const { dataset } = useAppState();
  const ev = useEvidenceState();
  const [tab, setTab] = useState<TabKey>('sessions');
  const [toast, setToast] = useState<string | null>(null);

  const sessionInfo = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    (dataset?.rowsByBatch['meal-1'] ?? []).forEach((r) => {
      if (!map.has(r.values.session_id)) map.set(r.values.session_id, r.values);
    });
    return map;
  }, [dataset]);

  const materials = useMemo(
    () => (ev.materialStore ? effectiveMaterials(ev.materialStore) : []),
    [ev.materialStore],
  );
  const materialById = useMemo(() => new Map(materials.map((m) => [m.materialId, m])), [materials]);

  if (!ev.evidenceDataset || !ev.materialStore || !ev.derivation) {
    return <div className="card empty">证据模块正在加载…</div>;
  }

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const doPreview = async (change: EvidenceChange) => {
    await ev.previewChange(change);
    setTab('preview');
  };

  const doCommit = async () => {
    try {
      await ev.commitPreview();
      flash('已提交：受影响判断已定向重算，旧运行保留当时解释');
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h1 className="page-title">证据语义与推导</h1>
      <p className="page-desc">
        从餐次成分判断追到实际用料依据：六态分别表达（已确认含有 / 可能含有 / 计划中使用 / 间接线索 / 资料不足 / 材料冲突），
        不折叠成可信分数。支持路径与反向依赖持久保存，材料撤回/更正后定向重算；旧运行保留当时解释。
      </p>

      {ev.recovered.length > 0 && (
        <div className="banner info">
          <b>页面恢复：</b>
          {ev.recovered.map((r) => (
            <div key={r}>{r}</div>
          ))}
        </div>
      )}
      {ev.conflict && (
        <div className="banner error">
          <b>材料版本冲突：</b>另一浏览器标签页已提交材料修订 r{ev.conflict.remoteRevision}（你基于 r
          {ev.conflict.localRevision}）。当前推导已同步到最新版本；未提交的预览如基于旧版本，提交时将被拒绝。
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={ev.dismissConflict}>
              我知道了
            </button>
          </div>
        </div>
      )}
      {ev.job && (
        <div className="banner warn">
          计算进行中（任务 {ev.job.jobId}，目标材料 r{ev.job.targetRevision}）…页面关闭后将在下次打开时续算。
        </div>
      )}

      <div className="banner info">
        材料修订 <b>r{ev.materialStore.revision}</b> · 推导版本 <b>r{ev.derivation.derivationRevision}</b>（
        {new Date(ev.derivation.computedAt).toLocaleString('zh-CN')}）· 判断 {ev.derivation.judgments.length} 项 ·
        更正记录 {ev.materialStore.corrections.length} 条
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>
          餐次判断（{ev.derivation.judgments.length}）
        </button>
        <button className={`tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>
          材料台账（{materials.length}）
        </button>
        <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>
          补证与预览{ev.draft ? '（有未提交预览）' : ''}
        </button>
        <button className={`tab ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
          推导运行（{ev.runs.length}）
        </button>
      </div>

      {tab === 'sessions' && (
        <SessionsTab
          judgments={ev.derivation.judgments}
          sessionInfo={sessionInfo}
          materials={materials}
          materialById={materialById}
          evidenceDataset={ev.evidenceDataset}
        />
      )}
      {tab === 'materials' && <MaterialsTab materials={materials} onPreview={(c) => void doPreview(c)} />}
      {tab === 'preview' && (
        <PreviewTab
          onImport={(batchId) => void doPreview({ type: 'IMPORT_SUPPLEMENT', batchId })}
          onCommit={() => void doCommit()}
          onDiscard={() => void ev.discardPreview()}
        />
      )}
      {tab === 'runs' && <RunsTab flash={flash} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------- 页签 1：餐次判断（餐次 → 锅次 → 投料 → 声明 → 原始行） ----------

function SessionsTab({
  judgments,
  sessionInfo,
  materials,
  materialById,
  evidenceDataset,
}: {
  judgments: IngredientJudgment[];
  sessionInfo: Map<string, Record<string, string>>;
  materials: EvidenceMaterial[];
  materialById: Map<string, EvidenceMaterial>;
  evidenceDataset: EvidenceDataset;
}) {
  const [pick, setPick] = useState<IngredientJudgment | null>(null);
  const counts = countStates(judgments);
  const bySession = new Map<string, IngredientJudgment[]>();
  judgments.forEach((j) => {
    const list = bySession.get(j.sessionId) ?? [];
    list.push(j);
    bySession.set(j.sessionId, list);
  });

  return (
    <div>
      <div className="card">
        <h2>六态统计（与本页判断同源，不折叠成分数）</h2>
        <div className="grid cols-3" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
          {JUDGMENT_STATE_ORDER.map((s) => (
            <div key={s} className="stat">
              <div className="label">{JUDGMENT_STATE_LABEL[s]}</div>
              <div className="value">{counts[s]}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0, marginTop: 10, fontSize: 12 }}>
          「资料不足」不等于不含过敏原；合并发餐不按整餐份数计暴露；未知不能统计为无过敏原。
        </p>
      </div>

      {Array.from(bySession.entries()).map(([sessionId, js]) => (
        <SessionCard
          key={sessionId}
          sessionId={sessionId}
          judgments={js}
          info={sessionInfo.get(sessionId)}
          materials={materials}
          materialById={materialById}
          evidenceDataset={evidenceDataset}
          onPick={setPick}
        />
      ))}

      {pick && (
        <JudgmentDrawer
          judgment={pick}
          materialById={materialById}
          evidenceDataset={evidenceDataset}
          onClose={() => setPick(null)}
        />
      )}
    </div>
  );
}

function SessionCard({
  sessionId,
  judgments,
  info,
  materials,
  materialById,
  evidenceDataset,
  onPick,
}: {
  sessionId: string;
  judgments: IngredientJudgment[];
  info?: Record<string, string>;
  materials: EvidenceMaterial[];
  materialById: Map<string, EvidenceMaterial>;
  evidenceDataset: EvidenceDataset;
  onPick: (j: IngredientJudgment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const pots = materials.filter((m) => m.kind === 'PRODUCTION_BATCH' && m.scope.sessionId === sessionId);
  const dests = materials.filter((m) => m.kind === 'SERVING_DESTINATION' && m.scope.sessionId === sessionId);
  const inputsOf = (potId: string) =>
    materials.filter((m) => m.kind === 'ACTUAL_INPUT' && (m.scope.potIds ?? []).includes(potId));
  const declsOf = (productCode: string) =>
    materials.filter((m) => m.kind === 'PRODUCT_DECLARATION' && m.attrs.product_code === productCode);

  const rowView = (rowId: string) => {
    const row = findEvidenceRow(evidenceDataset, rowId);
    return row ? <RawRowView batchId={row.batchId} lineNo={row.lineNo} values={row.values} /> : null;
  };

  return (
    <div className="card">
      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          餐次 <span className="mono">{sessionId}</span>
          <span className="muted" style={{ fontWeight: 400, marginLeft: 10, fontSize: 12 }}>
            {info ? `${info.school_id}校 · ${info.serving_date} · ${info.window} · 菜谱 ${info.recipe_id}` : ''}
          </span>
        </span>
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? '收起用料层级' : '展开锅次/投料/声明'}
        </button>
      </h2>

      <table className="data">
        <thead>
          <tr>
            <th>成分键</th>
            <th>判断（六态）</th>
            <th className="num">独立支持</th>
            <th className="num">转抄</th>
            <th>发餐范围</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {judgments.map((j) => (
            <tr key={j.judgmentId}>
              <td><b>{j.componentKey}</b></td>
              <td><JudgmentBadge state={j.state} /></td>
              <td className="num">{j.independentSupport}</td>
              <td className="num">{j.transcriptionCount > 0 ? j.transcriptionCount : '—'}</td>
              <td className="muted" style={{ fontSize: 12, maxWidth: 320 }}>
                {j.state === 'CONFIRMED_PRESENT'
                  ? j.servingScope.mergedServings > 0
                    ? `合并发餐 ${j.servingScope.mergedServings} 份，可归属 ${j.servingScope.attributableServingIds.length} 份`
                    : `逐份可归属 ${j.servingScope.attributableServingIds.length} 份`
                  : '—'}
              </td>
              <td>
                <button className="btn small" onClick={() => onPick(j)}>
                  支持路径/缺口/冲突
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <div style={{ marginTop: 14 }}>
          <h3>制作分锅与实际投料（逐层展开到原始行）</h3>
          {pots.map((pot) => {
            const potId = pot.scope.potIds?.[0] ?? '';
            const inputs = inputsOf(potId);
            return (
              <div key={pot.materialId} className="pot-block">
                <div className="pot-head">
                  <MaterialKindBadge kind="PRODUCTION_BATCH" /> 锅 <b>{pot.attrs.pot_label ?? potId}</b>
                  <span className="mono muted">（{potId} · 出品 {pot.attrs.produced_servings} 份）</span>
                  <button className="btn small" onClick={() => setOpenRow(openRow === pot.rowId ? null : pot.rowId)}>原始行</button>
                </div>
                {openRow === pot.rowId && rowView(pot.rowId)}
                {inputs.length === 0 && <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px 8px' }}>该锅无实际投料记录（缺口）</div>}
                {inputs.map((input) => (
                  <div key={input.materialId} className="input-block">
                    <div>
                      <MaterialKindBadge kind="ACTUAL_INPUT" />{' '}
                      {input.attrs.record_type === 'NON_INPUT' ? '未投料记录' : '实际投料'}：
                      <b>{input.attrs.ingredient_name}</b>
                      {input.attrs.product_code && (
                        <span className="mono muted">（{input.attrs.product_code} · 批次 {input.attrs.product_batch}）</span>
                      )}
                      {input.status === 'WITHDRAWN' && <span className="badge issue">已撤回</span>}
                      <button className="btn small" onClick={() => setOpenRow(openRow === input.rowId ? null : input.rowId)}>原始行</button>
                    </div>
                    {openRow === input.rowId && rowView(input.rowId)}
                    {input.attrs.record_type !== 'NON_INPUT' &&
                      declsOf(input.attrs.product_code ?? '').map((d) => (
                        <div key={d.materialId} className="decl-block">
                          <MaterialKindBadge kind="PRODUCT_DECLARATION" /> {d.attrs.component_key}：
                          <b>{d.attrs.declaration === 'CONTAINS' ? '声明含有' : d.attrs.declaration === 'MAY_CONTAIN' ? '可能含有' : '明确未检出'}</b>
                          <span className="muted mono" style={{ fontSize: 11 }}>
                            （配方 {d.scope.formulaId} · 批次 {d.scope.productBatch} · {d.attrs.source_ref}）
                          </span>
                          {d.status === 'WITHDRAWN' && <span className="badge issue">已撤回</span>}
                          <button className="btn small" onClick={() => setOpenRow(openRow === d.rowId ? null : d.rowId)}>原始行</button>
                          {openRow === d.rowId && rowView(d.rowId)}
                        </div>
                      ))}
                    {input.attrs.record_type !== 'NON_INPUT' && declsOf(input.attrs.product_code ?? '').length === 0 && (
                      <div className="muted" style={{ fontSize: 12, marginLeft: 8 }}>缺少该商品的成分声明（空白/缺声明不构成不含证据）</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          <h3>发餐去向</h3>
          {dests.map((d) => (
            <div key={d.materialId} style={{ fontSize: 13, marginBottom: 6 }}>
              <MaterialKindBadge kind="SERVING_DESTINATION" /> {d.attrs.window_label}：锅 {(d.scope.potIds ?? []).join('、')}
              {d.attrs.merged === 'YES' ? <b>（合并发餐 {d.attrs.serving_count} 份，无逐份去向）</b> : `（逐份 ${d.attrs.serving_ids || '无记录'}）`}
              <button className="btn small" onClick={() => setOpenRow(openRow === d.rowId ? null : d.rowId)}>原始行</button>
              {openRow === d.rowId && rowView(d.rowId)}
            </div>
          ))}
          <OtherMaterials sessionId={sessionId} materials={materials} materialById={materialById} evidenceDataset={evidenceDataset} />
        </div>
      )}
    </div>
  );
}

function OtherMaterials({
  sessionId,
  materials,
  materialById,
  evidenceDataset,
}: {
  sessionId: string;
  materials: EvidenceMaterial[];
  materialById: Map<string, EvidenceMaterial>;
  evidenceDataset: EvidenceDataset;
}) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const related = materials.filter(
    (m) =>
      (m.kind === 'PLAN_RECIPE' || m.kind === 'SUBSTITUTION' || m.kind === 'TRANSCRIPTION') &&
      m.scope.sessionId === sessionId,
  );
  if (related.length === 0) return null;
  return (
    <>
      <h3>计划 / 替换 / 转抄材料</h3>
      {related.map((m) => (
        <div key={m.materialId} style={{ fontSize: 13, marginBottom: 6 }}>
          <MaterialKindBadge kind={m.kind} /> <span className="mono">{m.materialId}</span>{' '}
          {m.kind === 'SUBSTITUTION'
            ? `${m.attrs.replaced_ingredient} → ${m.attrs.substitute_ingredient}（范围：${m.scope.scopeType === 'POTS' ? (m.scope.potIds ?? []).join('、') : m.scope.scopeType === 'ALL_DAY' ? '全日' : '未登记'}${m.scope.fullReplacement ? ' · 全量' : ''}）`
            : `${m.attrs.ingredient_name ?? ''} ${m.attrs.note ?? ''}`}
          {m.cites.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              （引用：{m.cites.map((c) => materialById.get(c)?.materialId ?? c).join('、')}）
            </span>
          )}
          {m.status === 'WITHDRAWN' && <span className="badge issue">已撤回</span>}
          <button className="btn small" onClick={() => setOpenRow(openRow === m.rowId ? null : m.rowId)}>原始行</button>
          {openRow === m.rowId && (() => {
            const row = findEvidenceRow(evidenceDataset, m.rowId);
            return row ? <RawRowView batchId={row.batchId} lineNo={row.lineNo} values={row.values} /> : null;
          })()}
        </div>
      ))}
    </>
  );
}

// ---------- 判断详情抽屉：支持路径 / 缺口 / 冲突双方原件 ----------

function JudgmentDrawer({
  judgment,
  materialById,
  evidenceDataset,
  onClose,
}: {
  judgment: IngredientJudgment;
  materialById: Map<string, EvidenceMaterial>;
  evidenceDataset: EvidenceDataset;
  onClose: () => void;
}) {
  const j = judgment;
  const rowOf = (rowId: string): RawRow | undefined => findEvidenceRow(evidenceDataset, rowId);
  return (
    <Drawer
      title={`${j.sessionId} · ${j.componentKey}`}
      subtitle={`${JUDGMENT_STATE_LABEL[j.state]} · 材料 r${j.materialRevision} · 独立支持 ${j.independentSupport} · 转抄 ${j.transcriptionCount}`}
      onClose={onClose}
    >
      <h3>结论说明</h3>
      <ul>
        {j.explanation.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>

      {j.conflicts.length > 0 && (
        <>
          <h3>同范围冲突（双方原件并列，不投票）</h3>
          {j.conflicts.map((c) => (
            <div key={c.scopeKey} className="conflict-box">
              <div className="muted" style={{ marginBottom: 6 }}>{c.note}（范围：{c.scopeLabel}）</div>
              <div className="grid cols-2">
                <div>
                  <b>已确认含有依据</b>
                  {c.supportMaterialIds.map((id) => (
                    <MaterialOrigin key={id} materialId={id} materialById={materialById} rowOf={rowOf} />
                  ))}
                </div>
                <div>
                  <b>明确相反记录</b>
                  {c.oppositeMaterialIds.map((id) => (
                    <MaterialOrigin key={id} materialId={id} materialById={materialById} rowOf={rowOf} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      <h3>支持路径（{j.paths.length}）</h3>
      {j.paths.length === 0 && <p className="muted">无可用支持路径。</p>}
      {j.paths.map((p) => (
        <div key={p.pathId} className={`path-block ${p.cycleBlocked && p.supportRoots.length === 0 ? 'blocked' : ''}`}>
          <div style={{ marginBottom: 4 }}>
            <PathLevelBadge level={p.level} />{' '}
            {p.complete ? <span className="badge ok">链路完整</span> : <span className="badge neutral">链路有缺口</span>}
            {p.cycleBlocked && <span className="badge issue">循环引用已阻断</span>}
            {p.potIds.length > 0 && <span className="muted" style={{ fontSize: 12 }}>　锅次：{p.potIds.join('、')}</span>}
          </div>
          <div className="trace">
            {p.links.map((l, i) => (
              <div className="step" key={i}>
                <b>{l.kind}</b> <span className="mono">{l.materialId}</span>：{l.note}{' '}
                <span className="mono muted">({l.rowId})</span>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            支持根原件：{p.supportRoots.length > 0 ? p.supportRoots.join('、') : '无（循环/已撤回）'}
            {p.gapNote && <div>缺口：{p.gapNote}</div>}
          </div>
        </div>
      ))}

      {j.opposites.length > 0 && (
        <>
          <h3>相反记录（按范围保留；范围不重叠时不构成冲突）</h3>
          {j.opposites.map((o) => (
            <div key={`${o.materialId}-${o.scopeKey}`} style={{ marginBottom: 8 }}>
              <span className="badge neutral">{o.scopeLabel}</span> {o.note}{' '}
              <span className="mono muted">({o.materialId})</span>
              {(() => {
                const row = rowOf(o.rowId);
                return row ? <RawRowView batchId={row.batchId} lineNo={row.lineNo} values={row.values} /> : null;
              })()}
            </div>
          ))}
        </>
      )}

      {j.gaps.length > 0 && (
        <>
          <h3>缺口</h3>
          <ul>
            {j.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </>
      )}

      <h3>发餐范围</h3>
      <p style={{ fontSize: 13 }}>{j.servingScope.note}</p>
    </Drawer>
  );
}

function MaterialOrigin({
  materialId,
  materialById,
  rowOf,
}: {
  materialId: string;
  materialById: Map<string, EvidenceMaterial>;
  rowOf: (rowId: string) => RawRow | undefined;
}) {
  const m = materialById.get(materialId);
  if (!m) return <div className="mono muted">{materialId}（未找到）</div>;
  const row = rowOf(m.rowId);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12 }}>
        <MaterialKindBadge kind={m.kind} /> <span className="mono">{m.materialId}</span>
        {m.status === 'WITHDRAWN' && <span className="badge issue">已撤回</span>}
      </div>
      {row && <RawRowView batchId={row.batchId} lineNo={row.lineNo} values={row.values} />}
    </div>
  );
}

// ---------- 页签 2：材料台账 ----------

function MaterialsTab({
  materials,
  onPreview,
}: {
  materials: EvidenceMaterial[];
  onPreview: (change: EvidenceChange) => void;
}) {
  const [rectifyTarget, setRectifyTarget] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState<'POTS' | 'ALL_DAY' | 'UNCLEAR'>('POTS');
  const [potsText, setPotsText] = useState('');
  const [full, setFull] = useState(true);

  const sorted = [...materials].sort((a, b) => a.kind.localeCompare(b.kind) || a.materialId.localeCompare(b.materialId));
  return (
    <div className="card">
      <h2>材料台账（{materials.length} 项，含已撤回；撤回/更正先预览影响再提交）</h2>
      <table className="data">
        <thead>
          <tr>
            <th>材料身份</th>
            <th>类型</th>
            <th>来源批次</th>
            <th>有效范围 / 内容</th>
            <th>引用</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.materialId}>
              <td className="mono" style={{ fontSize: 12 }}>{m.materialId}</td>
              <td><MaterialKindBadge kind={m.kind} /></td>
              <td className="mono" style={{ fontSize: 12 }}>{m.batchId}</td>
              <td style={{ fontSize: 12, maxWidth: 340 }}>
                {m.kind === 'SUBSTITUTION'
                  ? `${m.attrs.replaced_ingredient}→${m.attrs.substitute_ingredient} · ${m.scope.scopeType}${m.scope.potIds?.length ? `(${(m.scope.potIds ?? []).join('/')})` : ''}${m.scope.fullReplacement ? ' · 全量' : ''}`
                  : m.kind === 'PRODUCT_DECLARATION'
                    ? `${m.attrs.product_name} · ${m.attrs.component_key}=${m.attrs.declaration} · 批次 ${m.scope.productBatch}`
                    : m.kind === 'ACTUAL_INPUT'
                      ? `${m.attrs.record_type === 'NON_INPUT' ? '未投料' : '投料'} ${m.attrs.ingredient_name} → ${(m.scope.potIds ?? []).join('、')}`
                      : m.kind === 'SERVING_DESTINATION'
                        ? `${m.attrs.window_label} · 锅 ${(m.scope.potIds ?? []).join('+')}${m.attrs.merged === 'YES' ? ' 合并' : ''}`
                        : `${m.attrs.ingredient_name ?? m.attrs.window_label ?? m.attrs.pot_label ?? ''} ${m.scope.sessionId ?? ''}`}
              </td>
              <td className="mono muted" style={{ fontSize: 11 }}>{m.cites.join('、') || '—'}</td>
              <td>{m.status === 'WITHDRAWN' ? <span className="badge issue">已撤回</span> : <span className="badge ok">有效</span>}</td>
              <td>
                <div className="pill-group">
                  {m.status !== 'WITHDRAWN' && !m.supplement && (
                    <button
                      className="btn small danger"
                      onClick={() => onPreview({ type: 'WITHDRAW', materialId: m.materialId, note: '分析师在材料台账撤回该材料' })}
                    >
                      撤回…
                    </button>
                  )}
                  {m.kind === 'SUBSTITUTION' && m.status !== 'WITHDRAWN' && (
                    <button className="btn small" onClick={() => setRectifyTarget(rectifyTarget === m.materialId ? null : m.materialId)}>
                      更正范围…
                    </button>
                  )}
                </div>
                {rectifyTarget === m.materialId && (
                  <div className="rectify-form">
                    <select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)}>
                      <option value="POTS">指定锅次</option>
                      <option value="ALL_DAY">全日所有锅次</option>
                      <option value="UNCLEAR">范围未登记</option>
                    </select>
                    {scopeType === 'POTS' && (
                      <input
                        placeholder="锅次 id，分号分隔，如 POT-A1;POT-A2"
                        value={potsText}
                        onChange={(e) => setPotsText(e.target.value)}
                        style={{ width: 220 }}
                      />
                    )}
                    <label style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> 全量替换
                    </label>
                    <button
                      className="btn small primary"
                      onClick={() => {
                        onPreview({
                          type: 'RECTIFY_SCOPE',
                          materialId: m.materialId,
                          note: `分析师更正替换适用范围为 ${scopeType}${potsText ? `（${potsText}）` : ''}`,
                          newScope: {
                            scopeType,
                            potIds: scopeType === 'POTS' ? potsText.split(';').map((s) => s.trim()).filter(Boolean) : [],
                            fullReplacement: full,
                          },
                        });
                        setRectifyTarget(null);
                      }}
                    >
                      预览影响
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 页签 3：补证与预览 ----------

function PreviewTab({
  onImport,
  onCommit,
  onDiscard,
}: {
  onImport: (batchId: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const ev = useEvidenceState();
  const supplements = (ev.evidenceDataset?.manifest.batches ?? []).filter(
    (b) => b.status === 'SUPPLEMENT' && !(ev.materialStore?.importedSupplements ?? []).includes(b.batchId),
  );
  const draft = ev.draft;

  return (
    <div>
      <div className="card">
        <h2>补证批次（预览影响后才提交）</h2>
        {supplements.length === 0 ? (
          <p className="muted">无待导入的补证批次（已全部导入或清单为空）。</p>
        ) : (
          <table className="data">
            <thead>
              <tr><th>批次</th><th>类型</th><th>数据日期</th><th>说明</th><th></th></tr>
            </thead>
            <tbody>
              {supplements.map((b) => (
                <tr key={b.batchId}>
                  <td className="mono">{b.batchId}</td>
                  <td>{b.kind}</td>
                  <td>{b.dataDate}</td>
                  <td style={{ fontSize: 12 }}>{b.notes}</td>
                  <td><button className="btn small primary" onClick={() => onImport(b.batchId)}>预览影响</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          撤回材料或更正适用范围请前往「材料台账」页签操作，同样先进入本页预览。
        </p>
      </div>

      {draft && (
        <div className="card">
          <h2>影响预览（未提交，不影响正式结果）</h2>
          <div className="banner warn">
            {draft.preview.changeDescription}　·　基于材料 r{draft.preview.baseMaterialRevision} · 预览于{' '}
            {new Date(draft.preview.previewedAt).toLocaleString('zh-CN')}
          </div>

          <h3>受影响判断（{draft.preview.affectedJudgments.length} 项）</h3>
          {draft.preview.affectedJudgments.length === 0 ? (
            <p className="muted">本次变更不改变任何判断。</p>
          ) : (
            <table className="data">
              <thead>
                <tr><th>餐次</th><th>成分键</th><th>变更前</th><th></th><th>变更后</th><th>原因</th></tr>
              </thead>
              <tbody>
                {draft.preview.affectedJudgments.map((t) => (
                  <tr key={t.judgmentId}>
                    <td className="mono">{t.sessionId}</td>
                    <td><b>{t.componentKey}</b></td>
                    <td>{t.before ? <JudgmentBadge state={t.before} /> : <span className="muted">（无判断）</span>}</td>
                    <td>→</td>
                    <td>{t.after ? <JudgmentBadge state={t.after} /> : <span className="muted">（移除）</span>}</td>
                    <td style={{ fontSize: 12 }}>{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>六态计数前后对比</h3>
          <table className="data" style={{ maxWidth: 720 }}>
            <thead>
              <tr><th>状态</th><th className="num">变更前</th><th className="num">变更后</th></tr>
            </thead>
            <tbody>
              {JUDGMENT_STATE_ORDER.map((s) => (
                <tr key={s} className={draft.preview.countsBefore[s] !== draft.preview.countsAfter[s] ? 'count-changed' : ''}>
                  <td>{JUDGMENT_STATE_LABEL[s]}</td>
                  <td className="num">{draft.preview.countsBefore[s]}</td>
                  <td className="num"><b>{draft.preview.countsAfter[s]}</b></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="filter-bar" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={ev.busy} onClick={onCommit}>
              {ev.busy ? '提交并重算中…' : '提交变更（定向重算并生成新运行）'}
            </button>
            <button className="btn danger" disabled={ev.busy} onClick={() => void onDiscard()}>
              放弃预览
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            提交时重新校验材料修订号：若另一标签页已提交更新，本次提交被拒绝，不会覆盖他人结果；计算期间被更正的完成结果只留作旧资料计算。
          </p>
        </div>
      )}
      {!draft && <div className="card empty">当前没有未提交的预览。撤回材料、更正范围或导入补证批次后，影响预览会显示在这里（刷新/关闭页面后也会恢复）。</div>}
    </div>
  );
}

// ---------- 页签 4：推导运行 ----------

function RunsTab({ flash }: { flash: (msg: string) => void }) {
  const ev = useEvidenceState();
  const [check, setCheck] = useState<{ consistent: boolean; mismatches: string[] } | null>(null);
  const [viewRun, setViewRun] = useState<EvidenceRun | null>(null);

  const doCheck = async () => {
    const result = await ev.fullRecomputeCheck();
    setCheck(result);
    flash(result.consistent ? '全量重算校验通过：定向更新与从零推导一致' : `校验发现 ${result.mismatches.length} 处不一致`);
  };

  const doReset = async () => {
    if (window.confirm('将清空证据材料更正、推导与运行历史，恢复种子材料。确定？')) {
      await ev.resetEvidence();
      flash('证据工作区已重置为种子状态');
    }
  };

  return (
    <div>
      <div className="card">
        <h2>当前推导与一致性校验</h2>
        <p style={{ fontSize: 13 }}>
          实现方式：<b>保存支持路径与反向依赖，材料变化时定向重算</b>。全量重算校验用于证明定向结果与
          「每次分析前重新展开全部材料」的方案一致（可追查且一致）。
        </p>
        <div className="filter-bar">
          <button className="btn" onClick={() => void doCheck()}>全量重算校验</button>
          <button className="btn danger" onClick={() => void doReset()}>重置证据工作区</button>
        </div>
        {check && (
          <div className={`banner ${check.consistent ? 'info' : 'error'}`}>
            {check.consistent
              ? '校验通过：定向重算结果与全量推导完全一致，没有遗漏，也没有留下无依据的确认结果。'
              : `不一致：${check.mismatches.join('；')}`}
          </div>
        )}
      </div>

      <div className="card">
        <h2>推导运行（不可变快照，旧运行保留当时解释）</h2>
        <table className="data">
          <thead>
            <tr>
              <th>运行编号</th><th>生成时间</th><th>说明</th><th>材料修订</th><th>六态统计</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {ev.runs.map((r) => (
              <tr key={r.runId}>
                <td className="mono" style={{ fontSize: 12 }}>{r.runId}</td>
                <td className="nowrap">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                <td style={{ fontSize: 12, maxWidth: 260 }}>{r.note}</td>
                <td className="mono">r{r.materialRevision}</td>
                <td style={{ fontSize: 12 }}>
                  {JUDGMENT_STATE_ORDER.filter((s) => r.stats[s] > 0)
                    .map((s) => `${JUDGMENT_STATE_LABEL[s]} ${r.stats[s]}`)
                    .join(' · ')}
                </td>
                <td>
                  <div className="pill-group">
                    <button className="btn small" onClick={() => setViewRun(r)}>查看判断</button>
                    <button
                      className="btn small"
                      onClick={() => downloadJson(`${r.runId}-evidence.json`, buildEvidenceExport(r, new Date().toISOString()))}
                    >
                      导出 JSON
                    </button>
                    <button className="btn small" onClick={() => downloadCsv(`${r.runId}-evidence.csv`, judgmentsToCsv(r.judgments))}>
                      导出 CSV
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ev.stale.length > 0 && (
        <div className="card">
          <h2>旧资料计算（被并发更正取代，未覆盖当前推导）</h2>
          {ev.stale.map((s) => (
            <div key={s.jobId} className="banner warn">
              任务 {s.jobId}：{s.changeDescription}（基于材料 r{s.baseRevision}，完成时已被 r{s.supersededByRevision} 取代，
              {new Date(s.computedAt).toLocaleString('zh-CN')}）——结果仅留档，未生效。
            </div>
          ))}
        </div>
      )}

      {viewRun && (
        <Drawer
          title={`运行 ${viewRun.runId}`}
          subtitle={`材料 r${viewRun.materialRevision} · ${new Date(viewRun.createdAt).toLocaleString('zh-CN')} · ${viewRun.note}`}
          onClose={() => setViewRun(null)}
        >
          <p className="muted" style={{ fontSize: 12 }}>
            该运行为不可变快照：判断与解释保持生成时口径，不被后续证据静默替换。
          </p>
          {viewRun.judgments.map((j) => (
            <div key={j.judgmentId} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
              <JudgmentBadge state={j.state} /> <span className="mono">{j.sessionId}</span> <b>{j.componentKey}</b>
              <ul style={{ margin: '6px 0', fontSize: 12 }}>
                {j.explanation.slice(0, 3).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ))}
        </Drawer>
      )}
    </div>
  );
}

// ---------- 工具 ----------

function findEvidenceRow(dataset: EvidenceDataset, rowId: string): RawRow | undefined {
  const [batchId] = rowId.split('#');
  return dataset.rowsByBatch[batchId]?.find((r) => r.rowId === rowId);
}
