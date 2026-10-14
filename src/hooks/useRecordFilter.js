/**
 * 记录筛选 / 排序
 *
 * 单独抽出来是因为三栏都要吃这份结果：
 * 中栏列表按它渲染，左栏热力图按它决定谁变暗，统计条按它反显当前筛选口径。
 * 放在 App 里算一次，比每栏各算一遍便宜，也不会出现三栏口径不一致的怪事。
 */

import { useMemo } from 'react';

export const SORT_KEYS = {
  SEQ: 'seq',
  SEVERITY: 'severity',
  CHANGES: 'changes',
  DURATION: 'duration'
};

export const SORT_LABEL = {
  seq: '序号',
  severity: '严重度',
  changes: '变更量',
  duration: '耗时'
};

/**
 * @param {Array} records 全量记录
 * @param {object} opts
 * @param {string} opts.query          搜索词（匹配 seq / id / 左右名称 / 业务标签）
 * @param {string} opts.statusFilter   'all' | 'diff' | 'identical' | 'missing' | 'error' | 'pending'
 * @param {string} opts.sortKey        SORT_KEYS 之一
 * @param {boolean} opts.sortDesc
 * @param {number} opts.version        数据版本号，批处理推进时递增
 * @returns {{list: Array, matched: number}}
 */
export function useRecordFilter(records, opts) {
  const query = (opts.query || '').trim().toLowerCase();
  const statusFilter = opts.statusFilter || 'all';
  const sortKey = opts.sortKey || SORT_KEYS.SEQ;
  const sortDesc = !!opts.sortDesc;
  const version = opts.version || 0;

  return useMemo(() => {
    const src = records || [];
    let out = [];

    for (let i = 0; i < src.length; i += 1) {
      const r = src[i];

      // ---- 状态口径 ----------------------------------------------------
      //. 「有差异」是用户最关心的一类，把 changed / error 之外的异常都排除掉
      if (statusFilter !== 'all') {
        if (statusFilter === 'diff') {
          if (r.status !== 'changed') continue;
        } else if (statusFilter === 'pending') {
          if (r.status !== 'pending' && r.status !== 'running') continue;
        } else if (r.status !== statusFilter) {
          continue;
        }
      }

      // ---- 关键词 ------------------------------------------------------
      if (query) {
        const hay =
          String(r.seq) +
          ' ' +
          (r.id || '') +
          ' ' +
          (r.left_name || '') +
          ' ' +
          (r.right_name || '') +
          ' ' +
          (r.bizLabel || '');
        if (hay.toLowerCase().indexOf(query) < 0) continue;
      }

      out.push(r);
    }

    const dir = sortDesc ? -1 : 1;
    out.sort((a, b) => {
      let d = 0;
      if (sortKey === SORT_KEYS.SEVERITY) {
        d = ((a.stats && a.stats.severity) || 0) - ((b.stats && b.stats.severity) || 0);
      } else if (sortKey === SORT_KEYS.CHANGES) {
        const ca = a.stats ? (a.stats.added || 0) + (a.stats.removed || 0) : 0;
        const cb = b.stats ? (b.stats.added || 0) + (b.stats.removed || 0) : 0;
        d = ca - cb;
      } else if (sortKey === SORT_KEYS.DURATION) {
        d = (a.durationMs || 0) - (b.durationMs || 0);
      } else {
        d = (a.seq || 0) - (b.seq || 0);
      }
      //. 主键相同时回落到序号，保证排序稳定 —— 800 条里有大量 severity 相同的记录，
      //. 不稳定的排序会让列表在每次批处理刷新时乱跳
      if (d === 0) d = (a.seq || 0) - (b.seq || 0);
      return d * dir;
    });

    return { list: out, matched: out.length };
    //. version 必须参与依赖：记录是就地改的，不带上它筛选结果不会随批处理更新
  }, [records, query, statusFilter, sortKey, sortDesc, version]);
}

export default useRecordFilter;
