import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '../.env') });

async function run() {
    const config = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '4000'),
        database: 'test',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    };

    const conn = await mysql.createConnection(config);

    try {
        const [tables]: any = await conn.execute("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'test'");
        for (const tRow of tables) {
            const table = tRow.TABLE_NAME;
            try {
                const [countRes]: any = await conn.execute(`SELECT COUNT(*) as count FROM \`${table}\``);
                if (countRes[0].count === 21) {
                    console.log('TABLE WITH 21 ROWS:', table);
                    // Also check if karthick@amypo.in is in this table
                    const [target]: any = await conn.execute(`SELECT * FROM \`${table}\` LIMIT 1`);
                    if (target.length > 0) {
                        const cols = Object.keys(target[0]);
                        if (cols.includes('user_id') || cols.includes('student_id') || cols.includes('email')) {
                            const [check]: any = await conn.execute(`SELECT COUNT(*) as c FROM \`${table}\` WHERE (user_id = 35 OR user_id = 4 OR email = 'karthick@amypo.in')`);
                            console.log(`  karthick count in ${table}: ${check[0].c}`);
                        }
                    }
                }
            } catch (e) {}
        }
    } finally {
        await conn.end();
    }
}

run().catch(console.error);
