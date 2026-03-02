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
        const [tables]: any = await conn.execute("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns WHERE table_schema = 'test' AND COLUMN_NAME = 'batch_id'");
        for (const row of tables) {
            try {
                const [countRes]: any = await conn.execute(`SELECT COUNT(*) as count FROM \`${row.TABLE_NAME}\` WHERE batch_id = 4`);
                if (countRes[0].count === 21) {
                    console.log('MATCH FOUND IN TABLE:', row.TABLE_NAME);
                    // Check if it's courses
                    const [sample]: any = await conn.execute(`SELECT * FROM \`${row.TABLE_NAME}\` WHERE batch_id = 4 LIMIT 1`);
                    console.log('Sample Row:', JSON.stringify(sample));
                } else if (countRes[0].count > 0) {
                     console.log(`Table ${row.TABLE_NAME} has ${countRes[0].count} rows for batch 4`);
                }
            } catch (e) {}
        }
    } finally {
        await conn.end();
    }
}

run().catch(console.error);
