import * as mysql from "mysql2/promise";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function checkLanguagesSchema() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "4000"),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const [rows]: any = await connection.execute("DESCRIBE languages");
    console.log("Languages Schema:", JSON.stringify(rows));

    const [langs]: any = await connection.execute("SELECT * FROM languages LIMIT 5");
    console.log("Languages Sample:", JSON.stringify(langs));

  } finally {
    await connection.end();
  }
}

checkLanguagesSchema().catch(console.error);
