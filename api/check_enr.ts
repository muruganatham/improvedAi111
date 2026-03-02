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
        const [users]: any = await conn.execute("SELECT id, name, email, role FROM users WHERE email LIKE '%karthick%' OR name LIKE '%karthick%'");
        console.log('Users found:', JSON.stringify(users, null, 2));
    } finally {
        await conn.end();
    }
}

run().catch(console.error);
