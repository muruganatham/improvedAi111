const mysql = require('./api/node_modules/mysql2/promise');
const fs = require('fs');

(async () => {
  const conn = await mysql.createConnection({
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: 4000,
    user: '4U2ezhfza2XWo9c.root',
    password: 'Ph25p9PvUD9ejSxr',
    database: 'test',
    ssl: { rejectUnauthorized: false }
  });

  const results = {};

  // Get all tables
  const [tables] = await conn.execute('SHOW TABLES');
  const all = tables.map(r => r['Tables_in_test']);
  results.total_tables = all.length;
  results.all_tables = all;

  // Get row counts for all tables
  results.row_counts = {};
  for (const t of all) {
    try {
      const [r] = await conn.execute('SELECT COUNT(*) AS cnt FROM `' + t + '`');
      results.row_counts[t] = Number(r[0].cnt);
    } catch(e) { results.row_counts[t] = 'ERR: ' + e.message.substring(0,80); }
  }

  // Get column info for ALL tables (full schema dump)
  const [allCols] = await conn.execute(
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT " +
    "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='test' ORDER BY TABLE_NAME, ORDINAL_POSITION"
  );
  
  results.schema = {};
  for (const c of allCols) {
    const t = c.TABLE_NAME;
    if (!results.schema[t]) results.schema[t] = [];
    results.schema[t].push({
      col: c.COLUMN_NAME,
      type: c.COLUMN_TYPE,
      nullable: c.IS_NULLABLE,
      key: c.COLUMN_KEY,
      default: c.COLUMN_DEFAULT,
      comment: c.COLUMN_COMMENT
    });
  }

  // Get indexes
  const [indexes] = await conn.execute(
    "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS " +
    "WHERE TABLE_SCHEMA='test' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
  );
  results.indexes = indexes;

  // Check for foreign keys
  try {
    const [fks] = await conn.execute(
      "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME " +
      "FROM information_schema.KEY_COLUMN_USAGE " +
      "WHERE TABLE_SCHEMA='test' AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, COLUMN_NAME"
    );
    results.foreign_keys = fks;
  } catch(e) { results.foreign_keys = 'ERR: ' + e.message; }

  // Check DB engine and charset
  const [tblInfo] = await conn.execute(
    "SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, TABLE_COMMENT " +
    "FROM information_schema.TABLES WHERE TABLE_SCHEMA='test' ORDER BY TABLE_NAME"
  );
  results.table_info = tblInfo;

  fs.writeFileSync('./db_analysis_result.json', JSON.stringify(results, null, 2));
  console.log('DONE. Tables:', all.length, '| Written to db_analysis_result.json');
  await conn.end();
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
