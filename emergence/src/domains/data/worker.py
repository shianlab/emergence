"""Fixed, isolated reader. Never executes user Python, workbook macros or formulas."""

import csv
import datetime
import decimal
import importlib.metadata
import io
import json
import pathlib
import sys
import zipfile
from contextlib import ExitStack

sys.stdout.reconfigure(encoding="utf-8")
ROWS, COLS = 10000, 128
XLSX_BYTES = 64 * 1024 * 1024
XLSX_PARTS = 4096


def validate_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        parts = archive.infolist()
        if len(parts) > XLSX_PARTS:
            raise ValueError("Excel 文件部件数量超过预算")
        if sum(part.file_size for part in parts) > XLSX_BYTES:
            raise ValueError("Excel 解压大小超过预算")
        seen = set()
        remaining = XLSX_BYTES
        for part in parts:
            if part.filename in seen:
                raise ValueError("Excel 文件包含重复部件")
            seen.add(part.filename)
            if part.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError("Excel 文件使用了不支持的压缩方式")
            with archive.open(part) as stream:
                # Reading through EOF also checks ZIP integrity before XML parsing.
                while block := stream.read(min(128 * 1024, remaining + 1)):
                    remaining -= len(block)
                    if remaining < 0:
                        raise ValueError("Excel 解压大小超过预算")


def cell(v):
    if v is None:
        return None
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, bytes):
        raise ValueError("不支持二进制单元格")
    return str(v)


def table(request):
    path = pathlib.Path(request["input"])
    warnings, sheets, formulas = [], [], []
    kind = path.suffix.lower()
    if kind in (".csv", ".tsv"):
        raw = path.read_bytes()
        encoding = request.get("encoding") or "utf-8-sig"
        if encoding not in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
            raise ValueError("不支持的编码")
        try:
            text = raw.decode(encoding, errors="strict")
        except UnicodeError:
            raise ValueError("编码无法严格解码，请明确指定 gb18030 或 utf-16；未猜测或替换字符")
        delimiter = request.get("delimiter") or ("\t" if kind == ".tsv" else ",")
        if delimiter not in (",", "\t", ";", "|"):
            raise ValueError("不支持的分隔符")
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
        names = next(reader, [])
        if len(names) > COLS:
            raise ValueError("超过列数预算")
        rows = []
        for row in reader:
            if len(row) != len(names):
                raise ValueError("CSV 坏行：第 %s 条记录列数不一致" % (len(rows) + 2))
            rows.append([None if v == "" else v for v in row])
            if len(rows) > ROWS or len(rows) * len(names) > 100000:
                raise ValueError("超过 10000 行预算；未返回部分数据冒充全量")
        warnings.append(
            "文本列保留原始字符串，包括前导零、长整数和日期文本；空字段视为缺失，未自动转换日期。"
        )
    elif kind == ".xlsx":
        from openpyxl import load_workbook

        validate_xlsx(path)
        with ExitStack() as files:
            values = load_workbook(path, read_only=True, data_only=True, keep_links=False)
            files.callback(values.close)
            sheets = [sheet.title for sheet in values.worksheets]
            if not sheets:
                raise ValueError("Excel 文件没有可分析的数据工作表")
            selected = request.get("sheet")
            if not selected and len(sheets) != 1:
                return {
                    "selectSheet": True,
                    "sheets": sheets,
                    "warnings": ["多个工作表，请选择 sheet 后分析；未擅自合并。"],
                }
            selected = selected or sheets[0]
            if selected not in sheets:
                raise ValueError("工作表不存在")
            expressions = load_workbook(path, read_only=True, data_only=False, keep_links=False)
            files.callback(expressions.close)
            ws, fs = values[selected], expressions[selected]
            if ws.max_column and ws.max_column > COLS or ws.max_row and ws.max_row > ROWS + 1:
                raise ValueError("Excel 超过行列预算")
            rows = []
            names = []
            for i, (vr, fr) in enumerate(zip(ws.iter_rows(), fs.iter_rows())):
                if i > ROWS or len(vr) > COLS or i * len(vr) > 100000:
                    raise ValueError("Excel 超过行列预算")
                row = [cell(c.value) for c in vr]
                for v, f in zip(vr, fr):
                    if f.data_type == "f":
                        formulas.append({"cell": f.coordinate, "cacheMissing": v.value is None})
                if i == 0:
                    names = row
                else:
                    rows.append(row)
            if formulas:
                warnings.append("公式仅读取已保存缓存，未计算或验证缓存时效；缺缓存不等于零。")
    elif kind == ".parquet":
        import duckdb

        con = duckdb.connect(
            config={
                "threads": "1",
                "memory_limit": "256MB",
                "autoload_known_extensions": "false",
                "autoinstall_known_extensions": "false",
            }
        )
        try:
            cursor = con.execute("SELECT * FROM read_parquet(?) LIMIT 10001", [str(path)])
            names = [c[0] for c in cursor.description]
            if len(names) > COLS:
                raise ValueError("Parquet 超过列预算")
            rows = [[cell(v) for v in row] for row in cursor.fetchall()]
            if len(rows) > ROWS or len(rows) * len(names) > 100000:
                raise ValueError("Parquet 超过行预算")
        finally:
            con.close()
        warnings.append(
            "Parquet 类型值以精确文本返回；数值运算请显式 CAST，避免 JSON 长整数精度损失。"
        )
    else:
        raise ValueError("支持 CSV、TSV、XLSX、Parquet")
    if (
        not names
        or any(not isinstance(n, str) or not n.strip() or len(n) > 256 for n in names)
        or len(set(n.casefold() for n in names)) != len(names)
    ):
        raise ValueError("表头为空或重复，请明确列名后继续")
    if len(names) > COLS:
        raise ValueError("超过列数预算")
    if any(len(v) > 4000 for row in rows for v in row if v is not None):
        raise ValueError("单元格超过 4000 字符预算")
    columns = []
    for i, name in enumerate(names):
        vals = [row[i] for row in rows if row[i] is not None]
        numeric = 0
        dates = []
        for v in vals:
            try:
                if decimal.Decimal(v).is_finite():
                    numeric += 1
            except decimal.InvalidOperation:
                pass
            try:
                dates.append(datetime.date.fromisoformat(v).isoformat())
            except ValueError:
                pass
        leading_zero = any(len(v) > 1 and v.startswith("0") and v.isdigit() for v in vals)
        hint = (
            "identifier-like-text"
            if leading_zero
            else "iso-date-text"
            if vals and len(dates) == len(vals)
            else "numeric-text"
            if vals and numeric == len(vals)
            else "text"
        )
        columns.append(
            {
                "name": name,
                "typeHint": hint,
                "validIsoDates": len(dates),
                "dateRange": [min(dates), max(dates)] if dates else None,
                "storageType": "text",
                "missing": len(rows) - len(vals),
                "blankText": sum(not v.strip() for v in vals),
                "distinct": len(set(vals)),
                "candidateKey": bool(rows)
                and len(vals) == len(rows)
                and len(set(vals)) == len(rows),
            }
        )
    result = {
        "sqlTable": "data",
        "sqlExample": "SELECT COUNT(*) FROM data",
        "format": kind,
        "rows": len(rows),
        "scan": "full-within-budget",
        "columns": columns,
        "duplicateRows": len(rows) - len(set(tuple(r) for r in rows)),
        "sample": [[v[:120] if v is not None else None for v in r] for r in rows[:5]],
        "sheets": sheets,
        "formulaCount": len(formulas),
        "missingFormulaCaches": sum(f["cacheMissing"] for f in formulas),
        "warnings": warnings,
    }
    sql = request.get("sql")
    if sql:
        if formulas and any(f["cacheMissing"] for f in formulas):
            raise ValueError("存在缺失公式缓存，不能用不完整数值执行查询")
        import duckdb

        con = duckdb.connect(
            config={
                "threads": "1",
                "memory_limit": "256MB",
                "enable_external_access": "false",
                "autoload_known_extensions": "false",
                "autoinstall_known_extensions": "false",
            }
        )
        try:

            def quote(identifier):
                return '"' + identifier.replace('"', '""') + '"'

            con.execute(
                "CREATE TABLE data (" + ",".join(quote(n) + " VARCHAR" for n in names) + ")"
            )
            if rows:
                con.executemany(
                    "INSERT INTO data VALUES (" + ",".join("?" for _ in names) + ")", rows
                )
            statements = con.extract_statements(sql)
            if len(statements) != 1 or statements[0].type != duckdb.StatementType.SELECT:
                raise ValueError("仅允许单条 SELECT/WITH 查询；不允许写入、COPY、扩展加载或多语句")
            try:
                cursor = con.execute(sql)
            except Exception as error:
                raise ValueError(
                    "SQL 失败：查询表名固定为 data，不是源文件名；禁止外部文件/网络访问。示例 SELECT COUNT(*) FROM data。原始诊断："
                    + str(error)
                )
            headers = [d[0] for d in cursor.description]
            output = cursor.fetchmany(101)
            if len(headers) > COLS or len(output) > 100:
                raise ValueError("查询结果超过 100 行/128 列，请聚合或显式 LIMIT")
            result["query"] = {
                "columns": headers,
                "rows": [[cell(v) for v in row] for row in output],
                "sql": sql,
                "externalAccess": False,
            }
        finally:
            con.close()
    if request.get("method"):
        if formulas and any(f["cacheMissing"] for f in formulas):
            raise ValueError("存在缺失公式缓存，无法执行可靠分析")
        import runpy

        engine = runpy.run_path(str(pathlib.Path(__file__).with_name("analytics.py")))
        result["analysis"] = engine["compute"](
            request["method"], names, rows, request.get("params", {})
        )
    return result


try:
    request = json.load(sys.stdin)
    result = table(request)
    result["runtime"] = {
        "python": sys.version.split()[0],
        "duckdb": importlib.metadata.version("duckdb"),
        "openpyxl": importlib.metadata.version("openpyxl"),
        "scipy": importlib.metadata.version("scipy"),
        "numpy": importlib.metadata.version("numpy"),
    }
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)[:1500]}, ensure_ascii=False))
    sys.exit(1)
