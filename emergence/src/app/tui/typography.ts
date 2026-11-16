/** Native terminal hierarchy: no image text or per-element font-size assumption. */
export function headingStyle(level: number, columns: number) {
  return {
    bold: level <= 3,
    indent: level >= 3 && columns >= 36 ? 2 : level >= 3 ? 1 : 0,
    underlineRule: level === 1,
    after: level <= 2 ? 1 : 0,
  };
}
