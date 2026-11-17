// 推导引擎：由输入材料实际生成六态判断、支持路径、冲突与缺口
// 关键口径：
// - 已确认含有 = 实际投料 + 商品成分声明（含配方/批次）+ 发餐关系 全部齐备
// - 领料进厨房 ≠ 投进每锅；计划配方不能补成实际投料
// - 空白/缺声明/未命中不构成不含证据；相反结论只能来自明确的同范围实际记录
// - 合并发餐不按整餐份数计暴露；无逐份去向不推测个体摄入
import type {
  EvidenceMaterial,
  IngredientJudgment,
  JudgmentState,
  OppositeRecord,
  PathLevel,
  SupportPath,
  ConflictPair,
} from './types';
import { componentKeysOf } from './materials';
import { countIndependentSupports, supportRootsOf } from './graph';

export interface SessionInfo {
  sessionId: string;
  schoolId: string;
  servingDate: string;
  window: string;
  recipeId: string;
}

export interface DeriveInput {
  /** 已应用更正的材料集（含 WITHDRAWN 标记材料；撤回材料仍参与判断存在性与审计） */
  materials: EvidenceMaterial[];
  ingredientMap: Record<string, string[]>;
  sessions: SessionInfo[];
  materialRevision: number;
}

interface Ctx {
  active: EvidenceMaterial[];
  all: EvidenceMaterial[];
  byId: Map<string, EvidenceMaterial>;
  activeById: Map<string, EvidenceMaterial>;
  ingredientMap: Record<string, string[]>;
  sessions: Map<string, SessionInfo>;
  potsBySession: Map<string, EvidenceMaterial[]>;
  potById: Map<string, EvidenceMaterial>;
  inputsByPot: Map<string, EvidenceMaterial[]>;
  plansBySession: Map<string, EvidenceMaterial[]>;
  subsBySession: Map<string, EvidenceMaterial[]>;
  destsBySession: Map<string, EvidenceMaterial[]>;
  reqs: EvidenceMaterial[];
  declsByProduct: Map<string, EvidenceMaterial[]>;
  transBySession: Map<string, EvidenceMaterial[]>;
  materialRevision: number;
}

function push<K>(map: Map<K, EvidenceMaterial[]>, key: K, m: EvidenceMaterial): void {
  const list = map.get(key) ?? [];
  list.push(m);
  map.set(key, list);
}

function buildCtx(input: DeriveInput): Ctx {
  const all = input.materials;
  const active = all.filter((m) => m.status === 'ACTIVE');
  const byId = new Map(all.map((m) => [m.materialId, m]));
  const activeById = new Map(active.map((m) => [m.materialId, m]));

  const ctx: Ctx = {
    active,
    all,
    byId,
    activeById,
    ingredientMap: input.ingredientMap,
    sessions: new Map(input.sessions.map((s) => [s.sessionId, s])),
    potsBySession: new Map(),
    potById: new Map(),
    inputsByPot: new Map(),
    plansBySession: new Map(),
    subsBySession: new Map(),
    destsBySession: new Map(),
    reqs: [],
    declsByProduct: new Map(),
    transBySession: new Map(),
    materialRevision: input.materialRevision,
  };

  for (const m of active) {
    switch (m.kind) {
      case 'PRODUCTION_BATCH':
        if (m.scope.sessionId) push(ctx.potsBySession, m.scope.sessionId, m);
        (m.scope.potIds ?? []).forEach((p) => ctx.potById.set(p, m));
        break;
      case 'ACTUAL_INPUT':
        (m.scope.potIds ?? []).forEach((p) => push(ctx.inputsByPot, p, m));
        break;
      case 'PLAN_RECIPE':
        if (m.scope.sessionId) push(ctx.plansBySession, m.scope.sessionId, m);
        break;
      case 'SUBSTITUTION':
        if (m.scope.sessionId) push(ctx.subsBySession, m.scope.sessionId, m);
        break;
      case 'SERVING_DESTINATION':
        if (m.scope.sessionId) push(ctx.destsBySession, m.scope.sessionId, m);
        break;
      case 'REQUISITION':
        ctx.reqs.push(m);
        break;
      case 'PRODUCT_DECLARATION':
        push(ctx.declsByProduct, m.attrs.product_code ?? '', m);
        break;
      case 'TRANSCRIPTION':
        if (m.scope.sessionId) push(ctx.transBySession, m.scope.sessionId, m);
        break;
    }
  }
  return ctx;
}

/** 材料提到的成分键：名称映射 ∪ 关联商品的声明键（仅查 ACTIVE 声明） */
function keysOfMaterial(m: EvidenceMaterial, ctx: Ctx, activeDeclsOnly = true): string[] {
  const keys = new Set<string>();
  const name = m.attrs.ingredient_name ?? '';
  componentKeysOf(name, ctx.ingredientMap).forEach((k) => keys.add(k));
  if (m.kind === 'SUBSTITUTION') {
    componentKeysOf(m.attrs.replaced_ingredient ?? '', ctx.ingredientMap).forEach((k) => keys.add(k));
    componentKeysOf(m.attrs.substitute_ingredient ?? '', ctx.ingredientMap).forEach((k) => keys.add(k));
  }
  const product = m.attrs.product_code;
  if (product) {
    const decls = activeDeclsOnly
      ? (ctx.declsByProduct.get(product) ?? [])
      : ctx.all.filter((x) => x.kind === 'PRODUCT_DECLARATION' && x.attrs.product_code === product);
    decls.forEach((d) => keys.add(d.attrs.component_key ?? ''));
  }
  if (m.kind === 'PRODUCT_DECLARATION') keys.add(m.attrs.component_key ?? '');
  keys.delete('');
  return Array.from(keys);
}

function declValidOn(d: EvidenceMaterial, isoDateTime: string): boolean {
  const date = isoDateTime.slice(0, 10);
  const from = d.scope.validFrom;
  const to = d.scope.validTo;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function reqMatchesSession(req: EvidenceMaterial, s: SessionInfo): boolean {
  return (
    (req.schoolId === s.schoolId || req.schoolId === '*') &&
    (req.attrs.req_date ?? '') === s.servingDate &&
    (req.attrs.window ?? '') === s.window
  );
}

interface JudgmentBuilder {
  paths: SupportPath[];
  opposites: OppositeRecord[];
  gaps: string[];
  explanation: string[];
  referenced: Set<string>;
}

/** 推导单个（餐次 × 成分键）判断 */
export function deriveJudgment(
  sessionId: string,
  key: string,
  ctx: Ctx,
): IngredientJudgment | null {
  const session = ctx.sessions.get(sessionId);
  if (!session) return null;
  const b: JudgmentBuilder = {
    paths: [],
    opposites: [],
    gaps: [],
    explanation: [],
    referenced: new Set(),
  };

  const pots = ctx.potsBySession.get(sessionId) ?? [];
  const potIds = pots.flatMap((p) => p.scope.potIds ?? []);
  const dests = ctx.destsBySession.get(sessionId) ?? [];
  pots.forEach((p) => b.referenced.add(p.materialId));
  dests.forEach((d) => b.referenced.add(d.materialId));

  // ---- 1. 实际投料 + 商品声明 → 直接支持路径 / 相反记录 ----
  const confirmedPotIds = new Set<string>();
  for (const pot of pots) {
    for (const potId of pot.scope.potIds ?? []) {
      const inputs = ctx.inputsByPot.get(potId) ?? [];
      for (const input of inputs) {
        const recordType = input.attrs.record_type ?? 'INPUT';
        const inputKeys = keysOfMaterial(input, ctx);
        if (!inputKeys.includes(key)) continue;
        b.referenced.add(input.materialId);

        if (recordType === 'NON_INPUT') {
          // 明确的同范围未投料记录（相反记录）
          b.opposites.push({
            materialId: input.materialId,
            rowId: input.rowId,
            scopeKey: `pot:${potId}|${key}`,
            scopeLabel: `锅 ${potId}（${pot.attrs.pot_label ?? potId}）`,
            note: `未投料记录：${input.attrs.note || input.attrs.ingredient_name}`,
          });
          continue;
        }

        const decls = (ctx.declsByProduct.get(input.attrs.product_code ?? '') ?? []).filter(
          (d) =>
            d.attrs.component_key === key &&
            (d.scope.productBatch ?? '') === (input.attrs.product_batch ?? '') &&
            declValidOn(d, input.attrs.input_at ?? ''),
        );

        if (decls.length === 0) {
          // 有投料记录但缺少该批次声明：缺口，不能确认也不能否认
          b.paths.push({
            pathId: `${sessionId}|${key}|${input.materialId}|nocdecl`,
            level: 'INDIRECT',
            complete: false,
            links: [
              { materialId: input.materialId, rowId: input.rowId, kind: input.kind, note: `实际投料 ${input.attrs.ingredient_name}（批次 ${input.attrs.product_batch || '未知'}）` },
              { materialId: pot.materialId, rowId: pot.rowId, kind: pot.kind, note: `制作分锅 ${pot.attrs.pot_label ?? potId}` },
            ],
            supportRoots: [input.materialId],
            cycleBlocked: false,
            gapNote: '缺少该批次商品成分声明：投料事实本身只是线索，不能计为已确认',
            potIds: [potId],
          });
          b.gaps.push(`锅 ${pot.attrs.pot_label ?? potId} 投了 ${input.attrs.ingredient_name}，但缺少批次 ${input.attrs.product_batch || '未知'} 的商品成分声明`);
          continue;
        }

        for (const d of decls) {
          b.referenced.add(d.materialId);
          if (d.attrs.declaration === 'NOT_DETECTED') {
            b.opposites.push({
              materialId: d.materialId,
              rowId: d.rowId,
              scopeKey: `product:${input.attrs.product_code}|${input.attrs.product_batch}`,
              scopeLabel: `商品 ${d.attrs.product_name} 批次 ${input.attrs.product_batch}（锅 ${pot.attrs.pot_label ?? potId}）`,
              note: `明确未检出声明（配方 ${d.scope.formulaId ?? '?'}）：${d.attrs.source_ref ?? ''}`,
            });
            continue;
          }
          const level: PathLevel = d.attrs.declaration === 'CONTAINS' ? 'CONFIRMED' : 'MAY_CONTAIN';
          const dest = dests.find((x) => (x.scope.potIds ?? []).includes(potId));
          const roots = supportRootsOf(d.materialId, ctx.activeById);
          const links: SupportPath['links'] = [
            { materialId: d.materialId, rowId: d.rowId, kind: d.kind, note: `${d.attrs.product_name}（配方 ${d.scope.formulaId ?? '?'} · 批次 ${d.scope.productBatch ?? '?'}）声明${d.attrs.declaration === 'CONTAINS' ? '含有' : '可能含有'} ${key}` },
            { materialId: input.materialId, rowId: input.rowId, kind: input.kind, note: `实际投料 ${input.attrs.ingredient_name} → 锅 ${pot.attrs.pot_label ?? potId}` },
            { materialId: pot.materialId, rowId: pot.rowId, kind: pot.kind, note: `制作分锅：${pot.attrs.pot_label ?? potId} 属于本餐次` },
          ];
          if (dest) {
            links.push({ materialId: dest.materialId, rowId: dest.rowId, kind: dest.kind, note: `发餐去向：${dest.attrs.window_label ?? ''}（${dest.attrs.merged === 'YES' ? '合并发餐' : '分锅发餐'}）` });
            b.referenced.add(dest.materialId);
          }
          b.paths.push({
            pathId: `${sessionId}|${key}|${d.materialId}|${input.materialId}`,
            level,
            complete: Boolean(dest),
            links,
            supportRoots: roots.roots,
            cycleBlocked: roots.cycleBlocked,
            gapNote: dest ? undefined : '发餐去向缺失：投料与声明齐备，但无法关联到本餐次发餐，不能计入已确认',
            potIds: [potId],
          });
          if (dest && level === 'CONFIRMED') confirmedPotIds.add(potId);
          if (!dest) b.gaps.push(`锅 ${pot.attrs.pot_label ?? potId} 的发餐去向缺失，完整链路断裂`);
        }
      }
    }
  }

  // ---- 1b. 锅次缺口：整锅无任何实际投料记录 → 该锅成分无法确认 ----
  for (const pot of pots) {
    for (const potId of pot.scope.potIds ?? []) {
      const hasInput = (ctx.inputsByPot.get(potId) ?? []).some(
        (m) => (m.attrs.record_type ?? 'INPUT') === 'INPUT',
      );
      if (!hasInput) {
        b.gaps.push(`锅 ${pot.attrs.pot_label ?? potId}（${potId}）无实际投料记录，该锅成分无法确认`);
      }
    }
  }

  // ---- 2. 计划配方线索（替换范围不明确时保留仍成立的用料解释） ----
  const subs = (ctx.subsBySession.get(sessionId) ?? []).filter((s) => {
    const replacedKeys = componentKeysOf(s.attrs.replaced_ingredient ?? '', ctx.ingredientMap);
    return replacedKeys.includes(key);
  });
  subs.forEach((s) => b.referenced.add(s.materialId));
  const allDayFull = subs.some((s) => s.scope.scopeType === 'ALL_DAY' && s.scope.fullReplacement);
  const negatedPots = new Set(
    subs.filter((s) => s.scope.scopeType === 'POTS' && s.scope.fullReplacement).flatMap((s) => s.scope.potIds ?? []),
  );
  const unclearSubs = subs.filter((s) => s.scope.scopeType === 'UNCLEAR' || !s.scope.scopeType);

  for (const plan of ctx.plansBySession.get(sessionId) ?? []) {
    const planKeys = componentKeysOf(plan.attrs.ingredient_name ?? '', ctx.ingredientMap);
    if (!planKeys.includes(key)) continue;
    b.referenced.add(plan.materialId);
    if (allDayFull) {
      b.gaps.push(`全日全量替换登记（${subs.find((s) => s.scope.scopeType === 'ALL_DAY')?.materialId}），计划线索不再适用`);
      continue;
    }
    const remainingPots = potIds.filter((p) => !negatedPots.has(p));
    if (potIds.length > 0 && remainingPots.length === 0) {
      b.gaps.push('全部锅次均已登记全量替换，计划线索不再适用');
      continue;
    }
    b.paths.push({
      pathId: `${sessionId}|${key}|${plan.materialId}`,
      level: 'PLANNED',
      complete: true,
      links: [{ materialId: plan.materialId, rowId: plan.rowId, kind: plan.kind, note: `计划配方含 ${plan.attrs.ingredient_name} ${plan.attrs.planned_qty ?? ''}${plan.attrs.unit ?? ''}` }],
      supportRoots: [plan.materialId],
      cycleBlocked: false,
      potIds: remainingPots,
    });
    if (negatedPots.size > 0) {
      b.gaps.push(`锅 ${Array.from(negatedPots).join('、')} 已登记全量替换，计划中的${plan.attrs.ingredient_name}不适用于这些锅次`);
    }
    if (unclearSubs.length > 0) {
      b.gaps.push(
        `替换记录 ${unclearSubs.map((s) => s.materialId).join('、')} 范围未登记：保留仍成立的计划/领料线索，不因备注“已替代”删除整日关联`,
      );
    }
  }

  // ---- 3. 领料与转抄的间接线索 ----
  for (const req of ctx.reqs) {
    if (!reqMatchesSession(req, session)) continue;
    const reqKeys = keysOfMaterial(req, ctx);
    if (!reqKeys.includes(key)) continue;
    b.referenced.add(req.materialId);
    b.paths.push({
      pathId: `${sessionId}|${key}|${req.materialId}`,
      level: 'INDIRECT',
      complete: true,
      links: [{ materialId: req.materialId, rowId: req.rowId, kind: req.kind, note: `领料单 ${req.attrs.req_id} 列出 ${req.attrs.ingredient_name}（未注明用在哪锅）` }],
      supportRoots: [req.materialId],
      cycleBlocked: false,
      gapNote: '领料进厨房不证明投进每锅',
      potIds: [],
    });
  }

  for (const tr of ctx.transBySession.get(sessionId) ?? []) {
    const trKeys = componentKeysOf(tr.attrs.ingredient_name ?? '', ctx.ingredientMap);
    if (!trKeys.includes(key)) continue;
    b.referenced.add(tr.materialId);
    const roots = supportRootsOf(tr.materialId, ctx.activeById);
    b.paths.push({
      pathId: `${sessionId}|${key}|${tr.materialId}`,
      level: 'INDIRECT',
      complete: true,
      links: [{ materialId: tr.materialId, rowId: tr.rowId, kind: tr.kind, note: `${tr.attrs.note_kind}提及 ${tr.attrs.ingredient_name}（转抄自 ${tr.cites.join('、') || '无'}）` }],
      supportRoots: roots.roots,
      cycleBlocked: roots.cycleBlocked,
      gapNote: roots.cycleBlocked
        ? '循环引用：循环自身不产生事实支持'
        : '转抄材料：与所引原件同源，不增加证据强度',
      potIds: [],
    });
  }

  // ---- 4. 替换记录产生的相反记录（全量替换 = 该范围明确未使用） ----
  for (const s of subs) {
    if (!s.scope.fullReplacement) continue;
    if (s.scope.scopeType === 'POTS') {
      for (const potId of s.scope.potIds ?? []) {
        b.opposites.push({
          materialId: s.materialId,
          rowId: s.rowId,
          scopeKey: `pot:${potId}|${key}`,
          scopeLabel: `锅 ${potId}`,
          note: `全量替换：${s.attrs.replaced_ingredient} → ${s.attrs.substitute_ingredient}`,
        });
      }
    } else if (s.scope.scopeType === 'ALL_DAY') {
      b.opposites.push({
        materialId: s.materialId,
        rowId: s.rowId,
        scopeKey: `session:${sessionId}|${key}`,
        scopeLabel: `本餐次全日`,
        note: `全量替换：${s.attrs.replaced_ingredient} → ${s.attrs.substitute_ingredient}`,
      });
    }
  }

  // ---- 5. 冲突检测：同范围的已确认含有依据 × 明确相反记录（不同锅次/批次不误判） ----
  const conflicts: ConflictPair[] = [];
  const usablePaths = b.paths.filter((p) => !(p.cycleBlocked && p.supportRoots.length === 0));
  const completeConfirmed = usablePaths.filter((p) => p.level === 'CONFIRMED' && p.complete);
  for (const path of completeConfirmed) {
    const declLink = path.links.find((l) => l.kind === 'PRODUCT_DECLARATION');
    const inputMat = path.links.find((l) => l.kind === 'ACTUAL_INPUT');
    const input = inputMat ? ctx.activeById.get(inputMat.materialId) : undefined;
    const scopeKeys = new Set<string>();
    if (input) {
      scopeKeys.add(`product:${input.attrs.product_code}|${input.attrs.product_batch}`);
      (input.scope.potIds ?? []).forEach((p) => scopeKeys.add(`pot:${p}|${key}`));
    }
    scopeKeys.add(`session:${sessionId}|${key}`);
    for (const opp of b.opposites) {
      if (!scopeKeys.has(opp.scopeKey)) continue;
      if (conflicts.some((c) => c.scopeKey === opp.scopeKey)) continue;
      conflicts.push({
        scopeKey: opp.scopeKey,
        scopeLabel: opp.scopeLabel,
        supportMaterialIds: [declLink?.materialId ?? '', inputMat?.materialId ?? ''].filter(Boolean),
        oppositeMaterialIds: [opp.materialId],
        note: `同一范围（${opp.scopeLabel}）内，已确认含有依据与明确相反记录并存；并列双方原件，不按到达时间或来源数量投票`,
      });
    }
  }

  // ---- 6. 状态裁决 ----
  let state: JudgmentState;
  if (conflicts.length > 0) state = 'CONFLICT';
  else if (completeConfirmed.length > 0) state = 'CONFIRMED_PRESENT';
  else if (usablePaths.some((p) => p.level === 'MAY_CONTAIN' && p.complete)) state = 'LABEL_MAY_CONTAIN';
  else if (usablePaths.some((p) => p.level === 'PLANNED')) state = 'PLANNED_USE';
  else if (usablePaths.some((p) => p.level === 'INDIRECT')) state = 'INDIRECT_CLUE';
  else state = 'INSUFFICIENT';

  // ---- 7. 独立支持数与转抄统计 ----
  const directRoots = completeConfirmed.map((p) => p.supportRoots);
  const independentSupport = countIndependentSupports(directRoots);
  const allRootSets = usablePaths.map((p) => p.supportRoots);
  const transcriptionCount = usablePaths.filter(
    (p) =>
      p.links[0]?.kind === 'TRANSCRIPTION' &&
      allRootSets.some((other) => other !== p.supportRoots && other.some((r) => p.supportRoots.includes(r))),
  ).length;

  // ---- 8. 发餐范围：合并发餐不按整餐份数计暴露 ----
  const servingScope: IngredientJudgment['servingScope'] = {
    attributableServingIds: [],
    mergedServings: 0,
    note: '',
  };
  if (state === 'CONFIRMED_PRESENT') {
    for (const dest of dests) {
      const covered = (dest.scope.potIds ?? []).some((p) => confirmedPotIds.has(p));
      if (!covered) continue;
      const ids = (dest.attrs.serving_ids ?? '').split(';').map((s) => s.trim()).filter(Boolean);
      if (dest.attrs.merged === 'YES' || ids.length === 0) {
        servingScope.mergedServings += Number(dest.attrs.serving_count ?? 0) || 0;
      } else {
        servingScope.attributableServingIds.push(...ids);
      }
    }
    servingScope.note =
      servingScope.mergedServings > 0
        ? `存在含有记录（锅 ${Array.from(confirmedPotIds).join('、')}），但 ${servingScope.mergedServings} 份为合并发餐/无逐份去向：能确认本餐次存在含有记录，不代表所有份数都含有，已确认暴露份数只计可归属的 ${servingScope.attributableServingIds.length} 份`
        : `发餐逐份可归属：已确认暴露 ${servingScope.attributableServingIds.length} 份`;
  } else {
    servingScope.note = '未达到已确认含有，不涉及暴露份数统计；未知/不足不能统计为无过敏原';
  }

  // ---- 9. 结论说明 ----
  b.explanation = buildExplanation(state, key, sessionId, usablePaths, b.opposites, conflicts, independentSupport, transcriptionCount, servingScope, b.gaps);

  return {
    judgmentId: `${sessionId}|${key}`,
    sessionId,
    componentKey: key,
    state,
    paths: b.paths,
    opposites: b.opposites,
    conflicts,
    gaps: Array.from(new Set(b.gaps)),
    explanation: b.explanation,
    servingScope,
    independentSupport,
    transcriptionCount,
    materialRevision: ctx.materialRevision,
  };
}

function buildExplanation(
  state: JudgmentState,
  key: string,
  sessionId: string,
  paths: SupportPath[],
  opposites: OppositeRecord[],
  conflicts: ConflictPair[],
  independentSupport: number,
  transcriptionCount: number,
  servingScope: IngredientJudgment['servingScope'],
  gaps: string[],
): string[] {
  const out: string[] = [];
  switch (state) {
    case 'CONFIRMED_PRESENT': {
      const n = paths.filter((p) => p.level === 'CONFIRMED' && p.complete).length;
      out.push(`实际投料、商品成分声明（含配方/批次）与发餐关系齐备，${n} 条完整直接支持路径，独立支持 ${independentSupport} 条`);
      if (transcriptionCount > 0) out.push(`另有 ${transcriptionCount} 条转抄材料与原件同源，不增加证据强度`);
      if (opposites.length > 0) out.push(`存在 ${opposites.length} 条范围不重叠的相反记录（不同锅次/批次），不构成本范围冲突`);
      if (servingScope.mergedServings > 0) out.push(servingScope.note);
      break;
    }
    case 'LABEL_MAY_CONTAIN':
      out.push('实际投料的商品标签提示“可能含有”，按可能含有表达，不升级为已确认含有');
      break;
    case 'PLANNED_USE':
      out.push('计划配方使用该成分，但缺少覆盖全部适用范围的实际投料记录；计划不能补成实际投料');
      if (gaps.length > 0) out.push('其他窗口/餐次的完整用料记录仅适用于其自身范围，不能替本餐次补齐证据');
      break;
    case 'INDIRECT_CLUE':
      out.push('仅有间接线索（如领料进厨房、缺少批次声明的投料记录或转抄材料），不足以确认实际投料与成分');
      if (gaps.length > 0) out.push('其他窗口/餐次的完整用料记录仅适用于其自身范围，不能替本餐次补齐证据');
      break;
    case 'INSUFFICIENT':
      out.push('资料不足：没有完整且适用的支持路径；这不证明不含该成分，不能统计为无过敏原');
      break;
    case 'CONFLICT':
      out.push(`同一范围内已确认含有依据与明确相反记录并存（${conflicts.map((c) => c.scopeLabel).join('、')}），双方原件并列展示，不投票`);
      break;
  }
  gaps.forEach((g) => out.push(`缺口：${g}`));
  void sessionId;
  void key;
  return out;
}

/** 收集某餐次全部相关成分键（含已撤回材料：撤回后判断转为未知而非消失，保证可追查） */
function collectKeys(sessionId: string, ctx: Ctx): string[] {
  const keys = new Set<string>();
  const session = ctx.sessions.get(sessionId);
  const consider = (m: EvidenceMaterial) => {
    keysOfMaterial(m, ctx, false).forEach((k) => keys.add(k));
  };
  ctx.all.forEach((m) => {
    if (m.kind === 'PRODUCT_DECLARATION') return; // 声明经由投料/领料关联到餐次
    if (m.kind === 'PLAN_RECIPE' || m.kind === 'SUBSTITUTION' || m.kind === 'TRANSCRIPTION') {
      if (m.scope.sessionId === sessionId) consider(m);
    } else if (m.kind === 'REQUISITION') {
      if (session && reqMatchesSession(m, session)) consider(m);
    } else if (m.kind === 'ACTUAL_INPUT') {
      const pots = m.scope.potIds ?? [];
      if (pots.some((p) => ctx.potById.get(p)?.scope.sessionId === sessionId)) consider(m);
    }
  });
  // 投料商品对应的声明键（含已撤回声明）
  const pots = ctx.potsBySession.get(sessionId) ?? [];
  for (const pot of pots) {
    for (const potId of pot.scope.potIds ?? []) {
      // 用全部投料行（含撤回）找商品，再取该商品全部声明键
      ctx.all
        .filter((m) => m.kind === 'ACTUAL_INPUT' && (m.scope.potIds ?? []).includes(potId))
        .forEach((input) => {
          ctx.all
            .filter((d) => d.kind === 'PRODUCT_DECLARATION' && d.attrs.product_code === input.attrs.product_code)
            .forEach((d) => keys.add(d.attrs.component_key ?? ''));
        });
    }
  }
  keys.delete('');
  return Array.from(keys).sort();
}

/** 全部判断：餐次 × 成分键（仅对存在制作分锅记录的餐次生成判断——领料/异常幽灵餐次无锅次可关联） */
export function deriveAllJudgments(input: DeriveInput): IngredientJudgment[] {
  const ctx = buildCtx(input);
  const sessionIds = new Set<string>();
  input.materials.forEach((m) => {
    if (m.kind === 'PRODUCTION_BATCH' && m.scope.sessionId) sessionIds.add(m.scope.sessionId);
  });

  const out: IngredientJudgment[] = [];
  for (const sessionId of Array.from(sessionIds).sort()) {
    for (const key of collectKeys(sessionId, ctx)) {
      const j = deriveJudgment(sessionId, key, ctx);
      if (j) out.push(j);
    }
  }
  return out;
}

/** 判断引用的全部材料（用于反向依赖索引） */
export function referencedMaterialIds(j: IngredientJudgment, ctxInput: DeriveInput): string[] {
  const ctx = buildCtx(ctxInput);
  const refs = new Set<string>();
  j.paths.forEach((p) => p.links.forEach((l) => refs.add(l.materialId)));
  j.opposites.forEach((o) => refs.add(o.materialId));
  // 结构性材料与同会话提及该键的材料（含撤回），保证撤回/更正能沿引用找到本判断
  const sessionId = j.sessionId;
  ctx.all.forEach((m) => {
    if (m.kind === 'PRODUCTION_BATCH' && m.scope.sessionId === sessionId) refs.add(m.materialId);
    if (m.kind === 'SERVING_DESTINATION' && m.scope.sessionId === sessionId) refs.add(m.materialId);
    if (m.scope.sessionId === sessionId && keysOfMaterial(m, ctx, false).includes(j.componentKey)) {
      refs.add(m.materialId);
    }
    if (m.kind === 'REQUISITION') {
      const s = ctx.sessions.get(sessionId);
      if (s && reqMatchesSession(m, s) && keysOfMaterial(m, ctx, false).includes(j.componentKey)) {
        refs.add(m.materialId);
      }
    }
    if (m.kind === 'ACTUAL_INPUT') {
      const pots = m.scope.potIds ?? [];
      const inSession = pots.some((p) => ctx.potById.get(p)?.scope.sessionId === sessionId);
      if (inSession && keysOfMaterial(m, ctx, false).includes(j.componentKey)) refs.add(m.materialId);
    }
    if (m.kind === 'PRODUCT_DECLARATION') {
      // 该餐次投料商品的声明（含撤回）
      const touched = j.paths.some((p) => p.links.some((l) => l.materialId === m.materialId));
      if (touched) refs.add(m.materialId);
    }
  });
  return Array.from(refs).sort();
}

export function buildReverseIndex(
  judgments: IngredientJudgment[],
  input: DeriveInput,
): Record<string, string[]> {
  const index: Record<string, Set<string>> = {};
  for (const j of judgments) {
    for (const mid of referencedMaterialIds(j, input)) {
      (index[mid] ??= new Set()).add(j.judgmentId);
    }
  }
  return Object.fromEntries(Object.entries(index).map(([k, v]) => [k, Array.from(v).sort()]));
}

export { buildCtx as __buildCtxForTest };
