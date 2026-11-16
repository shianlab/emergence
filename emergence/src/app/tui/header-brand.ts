export function headerBrandLayout(width: number, height: number) {
  const columns = width >= 46 && height >= 24 ? 8 : 0;
  const rows = columns ? 3 : 1;
  return { columns, rows, height: rows + 2 };
}
