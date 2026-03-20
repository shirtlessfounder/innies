export function clampPageIndex(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(index, 0), pageCount - 1);
}

export function getPageButtonState(pageIndex: number, pageCount: number): {
  canScrollLeft: boolean;
  canScrollRight: boolean;
} {
  const current = clampPageIndex(pageIndex, pageCount);

  return {
    canScrollLeft: current > 0,
    canScrollRight: current < pageCount - 1,
  };
}

export function chunkIntoPanePages<T>(items: readonly T[], pageSize: number): T[][] {
  if (pageSize <= 0) return [];

  const pages: T[][] = [];

  for (let index = 0; index < items.length; index += pageSize) {
    pages.push(items.slice(index, index + pageSize));
  }

  return pages;
}
