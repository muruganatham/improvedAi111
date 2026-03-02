const { databaseConnectionService } = require('./src/services/database-connection.service');

async function test() {
    const dbMock = { _id: "000000000000000000000002", type: "mysql" };
    const DB_NAME = "coderv4";

    console.log("=== COLUMNS in course_academic_maps ===");
    const res1 = await databaseConnectionService.executeQuery(dbMock, "DESCRIBE course_academic_maps", { databaseName: DB_NAME });
    console.log(res1.data);

    console.log("\n=== COLUMNS in college_info ===");
    const res2 = await databaseConnectionService.executeQuery(dbMock, "DESCRIBE college_info", { databaseName: DB_NAME });
    console.log(res2.data);

    process.exit(0);
}
test().catch(console.error);
