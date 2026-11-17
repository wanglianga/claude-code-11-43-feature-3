// 引用（转抄）图：根原件解析、循环检测、独立支持判定
import type { EvidenceMaterial } from './types';

export interface CitationClosure {
  /** 引用闭包中的叶节点（无上游引用的原始材料） */
  roots: string[];
  /** 闭包中检测到的循环（循环自身不产生事实支持） */
  inCycle: boolean;
  /** 闭包涉及的全部材料 id */
  visited: string[];
}

/**
 * 计算材料的引用闭包：
 * - 叶节点 = 没有上游引用的材料（原始件）
 * - 若闭包中存在环，则该闭包标记 inCycle；环上材料不能作为事实支持的根
 */
export function citationClosure(
  startId: string,
  byId: Map<string, EvidenceMaterial>,
): CitationClosure {
  const roots = new Set<string>();
  const visited = new Set<string>();
  let inCycle = false;

  // 迭代 DFS，记录当前栈以检测回边
  const stack: Array<{ id: string; expanding: boolean }> = [{ id: startId, expanding: false }];
  const inStack = new Set<string>([startId]);
  const done = new Set<string>();

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (!top.expanding) {
      top.expanding = true;
      visited.add(top.id);
      const mat = byId.get(top.id);
      const cites = mat?.cites ?? [];
      if (cites.length === 0) {
        roots.add(top.id);
        done.add(top.id);
        stack.pop();
        inStack.delete(top.id);
        continue;
      }
      let pushed = false;
      for (const c of cites) {
        if (inStack.has(c)) {
          inCycle = true;
          continue;
        }
        if (!done.has(c)) {
          stack.push({ id: c, expanding: false });
          inStack.add(c);
          pushed = true;
        }
      }
      if (!pushed) {
        done.add(top.id);
        stack.pop();
        inStack.delete(top.id);
      }
    } else {
      done.add(top.id);
      stack.pop();
      inStack.delete(top.id);
    }
  }

  return { roots: Array.from(roots).sort(), inCycle, visited: Array.from(visited).sort() };
}

/**
 * 终端主张材料的支持根：若闭包含循环，则循环部分不提供任何根；
 * 仍有独立原始件时，这些根单独成立（一条坏路径不抹掉全部有效依据）。
 */
export function supportRootsOf(
  materialId: string,
  byId: Map<string, EvidenceMaterial>,
): { roots: string[]; cycleBlocked: boolean } {
  const closure = citationClosure(materialId, byId);
  if (!closure.inCycle) {
    return { roots: closure.roots, cycleBlocked: false };
  }
  // 有循环：仅保留“不经由循环也可达”的根——即根材料的闭包自身不含循环
  const cleanRoots: string[] = [];
  for (const r of closure.roots) {
    const sub = citationClosure(r, byId);
    if (!sub.inCycle) cleanRoots.push(r);
  }
  return { roots: Array.from(new Set(cleanRoots)).sort(), cycleBlocked: true };
}

/**
 * 独立支持数：把多条路径的支持根做并查集归并，
 * 根集合互不重叠的路径组各自计为一条独立支持；同源转抄归并为一组。
 */
export function countIndependentSupports(rootSets: string[][]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  rootSets.forEach((set) => {
    for (let i = 1; i < set.length; i++) union(set[0], set[i]);
  });
  const groups = new Set<string>();
  rootSets.forEach((set) => {
    if (set.length > 0) groups.add(find(set[0]));
  });
  return groups.size;
}
