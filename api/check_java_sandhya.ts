import * as mysql from "mysql2/promise";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function checkJavaPerformance() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "4000"),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    // Java is l_id = 1 (primary id in languages table)
    const javaLangId = 1;

    // Find Sandhya M
    const [users]: any = await connection.execute("SELECT id, name FROM users WHERE name LIKE 'sandhya M%'");
    if (users.length === 0) {
      console.log("User sandhya M not found.");
      return;
    }
    const userId = users[0].id;

    // Get all Java questions
    const [javaQuestions]: any = await connection.execute("SELECT id FROM standard_qb_codings WHERE l_id = ?", [javaLangId]);
    const javaQuestionIds = javaQuestions.map((q: any) => q.id);

    const [academicJava]: any = await connection.execute("SELECT id FROM academic_qb_codings WHERE l_id = ?", [javaLangId]);
    const academicIds = academicJava.map((q: any) => q.id);
    
    const allQuestionIds = [...javaQuestionIds, ...academicIds];

    if (allQuestionIds.length === 0) {
      console.log("No Java questions found.");
      return;
    }

    const [tables]: any = await connection.execute(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = 'test' AND TABLE_NAME LIKE '%_coding_result'"
    );

    const resultTables = tables.map((t: any) => t.TABLE_NAME);

    let javaTotal = 0;
    for (const table of resultTables) {
      const [res]: any = await connection.execute(
        `SELECT SUM(mark) as total FROM ${table} WHERE user_id = ? AND question_id IN (${allQuestionIds.join(",")})`,
        [userId]
      );
      javaTotal += parseFloat(res[0].total || 0);
    }

    console.log(`sandhya M (Java): ${javaTotal} marks`);

  } finally {
    await connection.end();
  }
}

checkJavaPerformance().catch(console.error);
