import { Pool } from "pg";

type Queryable = { query: Pool["query"] };

export type ColumnInfo = { name: string; dataType: string; nullable: boolean; defaultExpression: string | null };
export type TableInfo = { name: string; columns: ColumnInfo[] };
export type SchemaSnapshot = {
  tables: Record<string, TableInfo>;
  constraints: Map<string, string>; // name -> normalized pg_get_constraintdef()
  indexes: Map<string, string>;     // name -> normalized definition (from pg_indexes.indexdef)
  functions: Map<string, string>;   // name -> normalized pg_get_functiondef()
  triggers: Map<string, string>;    // "name@table" -> normalized pg_get_triggerdef()
  extensions: Set<string>;
};

/**
 * Normalizes a Postgres-reconstructed definition string so equivalent
 * definitions compare equal regardless of incidental formatting
 * differences: strips "public."/schema qualification (Postgres doesn't
 * always qualify every part of a definition consistently — confirmed
 * directly: pg_get_triggerdef qualifies the table but not the function
 * call it invokes), collapses all whitespace/newlines to single spaces,
 * and trims. Does NOT alter the actual SQL semantics — only
 * presentation — so a genuinely different definition still compares
 * unequal.
 */
export function normalizeDefinition(def: string): string {
  return def
    .replace(/\bpublic\./gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Captures the database's actual, current schema state directly from
 * Postgres's own system catalogs — never by parsing any SQL source
 * text. Compares real DEFINITIONS (via pg_get_constraintdef,
 * pg_get_indexdef-equivalent, pg_get_functiondef, pg_get_triggerdef),
 * not merely object names — an object with the correct name but a
 * different definition must never be mistaken for a match.
 */
export async function captureSchemaSnapshot(pool: Queryable): Promise<SchemaSnapshot> {
  const columnsResult = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const tables: Record<string, TableInfo> = {};
  for (const row of columnsResult.rows) {
    if (!tables[row.table_name]) tables[row.table_name] = { name: row.table_name, columns: [] };
    tables[row.table_name].columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultExpression: row.column_default !== null ? normalizeDefinition(row.column_default) : null,
    });
  }

  const constraintsResult = await pool.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
  `);
  const constraints = new Map<string, string>(constraintsResult.rows.map((r) => [r.conname as string, normalizeDefinition(r.def as string)]));

  const indexesResult = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`);
  const indexes = new Map<string, string>(indexesResult.rows.map((r) => [r.indexname as string, normalizeDefinition(r.indexdef as string)]));

  const functionsResult = await pool.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  `);
  const functions = new Map<string, string>(functionsResult.rows.map((r) => [r.proname as string, normalizeDefinition(r.def as string)]));

  const triggersResult = await pool.query(`
    SELECT t.tgname, c.relname AS table_name, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  `);
  const triggers = new Map<string, string>(triggersResult.rows.map((r) => [`${r.tgname}@${r.table_name}`, normalizeDefinition(r.def as string)]));

  const extensionsResult = await pool.query(`SELECT extname FROM pg_extension`);
  const extensions = new Set<string>(extensionsResult.rows.map((r) => r.extname as string));

  return { tables, constraints, indexes, functions, triggers, extensions };
}

/** Computes exactly what's present in `after` but not in `before`, or
 *  present in both but with a DIFFERENT definition — used by the
 *  manifest generator to determine what a single migration
 *  specifically introduces or changes, by snapshotting immediately
 *  before and after it runs. */
export function diffSchemaSnapshots(before: SchemaSnapshot, after: SchemaSnapshot): SchemaSnapshot {
  const tables: Record<string, TableInfo> = {};
  for (const [tableName, afterTable] of Object.entries(after.tables)) {
    const beforeTable = before.tables[tableName];
    if (!beforeTable) {
      tables[tableName] = afterTable;
      continue;
    }
    const newOrChangedColumns = afterTable.columns.filter((c) => {
      const beforeColumn = beforeTable.columns.find((bc) => bc.name === c.name);
      return !beforeColumn || beforeColumn.dataType !== c.dataType || beforeColumn.nullable !== c.nullable || beforeColumn.defaultExpression !== c.defaultExpression;
    });
    if (newOrChangedColumns.length > 0) tables[tableName] = { name: tableName, columns: newOrChangedColumns };
  }
  const diffMap = (b: Map<string, string>, a: Map<string, string>) => {
    const out = new Map<string, string>();
    for (const [k, v] of a) if (b.get(k) !== v) out.set(k, v);
    return out;
  };
  return {
    tables,
    constraints: diffMap(before.constraints, after.constraints),
    indexes: diffMap(before.indexes, after.indexes),
    functions: diffMap(before.functions, after.functions),
    triggers: diffMap(before.triggers, after.triggers),
    extensions: new Set([...after.extensions].filter((e) => !before.extensions.has(e))),
  };
}

export function emptySnapshot(): SchemaSnapshot {
  return { tables: {}, constraints: new Map(), indexes: new Map(), functions: new Map(), triggers: new Map(), extensions: new Set() };
}

/**
 * True if `actual` contains every table/column (with matching type,
 * nullability, AND default expression)/constraint/index/function/
 * trigger/extension present in `required`, with matching DEFINITIONS —
 * not merely matching names. An object bearing the correct name but a
 * different, incorrect definition is reported as missing/mismatched,
 * exactly as if it were absent — this is what closes the real gap
 * found: a name-only check could never distinguish "the real object"
 * from "an object with the same name but the wrong rule".
 */
export function schemaSatisfies(actual: SchemaSnapshot, required: SchemaSnapshot): { complete: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const [tableName, requiredTable] of Object.entries(required.tables)) {
    const actualTable = actual.tables[tableName];
    if (!actualTable) {
      missing.push(`table ${tableName}`);
      continue;
    }
    for (const requiredColumn of requiredTable.columns) {
      const actualColumn = actualTable.columns.find((c) => c.name === requiredColumn.name);
      if (!actualColumn) {
        missing.push(`column ${tableName}.${requiredColumn.name}`);
      } else if (actualColumn.dataType !== requiredColumn.dataType) {
        missing.push(`column ${tableName}.${requiredColumn.name} (expected type ${requiredColumn.dataType}, found ${actualColumn.dataType})`);
      } else if (actualColumn.nullable !== requiredColumn.nullable) {
        missing.push(`column ${tableName}.${requiredColumn.name} (expected nullable=${requiredColumn.nullable}, found ${actualColumn.nullable})`);
      } else if (actualColumn.defaultExpression !== requiredColumn.defaultExpression) {
        missing.push(`column ${tableName}.${requiredColumn.name} (expected default ${JSON.stringify(requiredColumn.defaultExpression)}, found ${JSON.stringify(actualColumn.defaultExpression)})`);
      }
    }
  }

  const checkDefMap = (label: string, requiredMap: Map<string, string>, actualMap: Map<string, string>) => {
    for (const [name, requiredDef] of requiredMap) {
      const actualDef = actualMap.get(name);
      if (actualDef === undefined) {
        missing.push(`${label} ${name}`);
      } else if (actualDef !== requiredDef) {
        missing.push(`${label} ${name} (definition mismatch — expected "${requiredDef}", found "${actualDef}")`);
      }
    }
  };
  checkDefMap("constraint", required.constraints, actual.constraints);
  checkDefMap("index", required.indexes, actual.indexes);
  checkDefMap("function", required.functions, actual.functions);
  checkDefMap("trigger", required.triggers, actual.triggers);

  for (const e of required.extensions) if (!actual.extensions.has(e)) missing.push(`extension ${e}`);

  return { complete: missing.length === 0, missing };
}
