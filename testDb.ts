import { databaseConnectionService } from "./api/src/services/database-connection.service.js";
import 'dotenv/config.js';

async function test() {
    const dbMock = { _id: "000000000000000000000002", type: "mysql" } as any;
    const dbName = "coderv4";

    const sql = `SELECT * FROM users u WHERE u.id = 2372`;
    console.log("Running:", sql);
    const res = await databaseConnectionService.executeQuery(dbMock, sql, { databaseName: dbName });
    console.log("Result:", res);
    process.exit(0);
}
test();
