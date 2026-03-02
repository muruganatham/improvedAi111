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
        const [tables]: any = await conn.execute("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'test' AND (TABLE_NAME LIKE '%result%' OR TABLE_NAME LIKE '%test_data%' OR TABLE_NAME LIKE '%segregation%')");
        
        const courses = new Set();
        for (const tRow of tables) {
            const table = tRow.TABLE_NAME;
            try {
                const [cols]: any = await conn.execute(`SHOW COLUMNS FROM \`${table}\``);
                const hasUser = cols.some(c => c.Field === 'user_id');
                const hasCourse = cols.some(c => c.Field === 'course_id');
                
                if (hasUser && hasCourse) {
                    const [res]: any = await conn.execute(`SELECT DISTINCT course_id FROM \`${table}\` WHERE user_id = 35`);
                    res.forEach(r => {
                        if (r.course_id) courses.add(r.course_id);
                    });
                    if (res.length > 0) {
                        console.log(`Table ${table} has ${res.length} courses for user 35`);
                    }
                }
            } catch (e) {}
        }

        console.log('\n--- Final Result ---');
        console.log('Unique Course IDs for User 35:', Array.from(courses));
        console.log('Total Unique Courses:', courses.size);

        if (courses.size > 0) {
            const [courseDetails]: any = await conn.execute(`SELECT id, course_name FROM courses WHERE id IN (${Array.from(courses).join(',')})`);
            console.log('\nCourse Details:');
            console.log(JSON.stringify(courseDetails, null, 2));
        }

    } finally {
        await conn.end();
    }
}

run().catch(console.error);
