import * as mysql from "mysql2/promise";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function findAllScores() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "4000"),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const [users]: any = await connection.execute("SELECT id, name FROM users WHERE name LIKE 'sandhya M%'");
    if (users.length === 0) {
      console.log("User sandhya M not found.");
      return;
    }
    const userId = users[0].id;

    const [tables]: any = await connection.execute(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = 'test' AND TABLE_NAME LIKE '%_coding_result'"
    );
    const resultTables = tables.map((t: any) => t.TABLE_NAME);

    const scoresMap: Record<number, number> = {};

    for (const table of resultTables) {
      const [res]: any = await connection.execute(
        `SELECT question_id, SUM(mark) as total FROM ${table} WHERE user_id = ? GROUP BY question_id HAVING total > 0`,
        [userId]
      );
      
      for (const row of res) {
        // Find language for this question
        const [q]: any = await connection.execute("SELECT l_id FROM standard_qb_codings WHERE id = ?", [row.question_id]);
        if (q.length > 0) {
            scoresMap[q[0].l_id] = (scoresMap[q[0].l_id] || 0) + parseFloat(row.total);
        } else {
            const [aq]: any = await connection.execute("SELECT l_id FROM academic_qb_codings WHERE id = ?", [row.question_id]);
            if (aq.length > 0) {
                scoresMap[aq[0].l_id] = (scoresMap[aq[0].l_id] || 0) + parseFloat(row.total);
            }
        }
      }
    }

    const [langs]: any = await connection.execute("SELECT id, language_name FROM languages");
    const langMap = langs.reduce((acc: any, curr: any) => {
        acc[curr.id] = curr.language_name;
        return acc;
    }, {});

    console.log("Scores for sandhya M:");
    for (const lid in scoresMap) {
        console.log(`${langMap[lid] || lid}: ${scoresMap[lid]} marks`);
    }

  } finally {
    await connection.end();
  }
}

findAllScores().catch(console.error);
