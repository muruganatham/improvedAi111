const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function checkApiKey() {
    const connection = await mysql.createConnection({
        host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
        port: 4000,
        user: '2t1jAS3VLf87hHb.root',
        password: process.env.DB_PASSWORD, // oTUYCaOiKHxYhu6B
        database: 'coderv4',
        ssl: {
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true
        }
    });

    try {
        const [tables] = await connection.execute('SHOW TABLES');
        console.log('Got tables');

        // Find any api key tables
        const apiKeyTables = tables.filter(t => Object.values(t)[0].toLowerCase().includes('api'));
        console.log('API key tables:', apiKeyTables);

        // Check if the key exists somewhere.
        // The key is aaddebcb805849c9af656b5b03d19818
        const key = 'aaddebcb805849c9af656b5b03d19818';

        console.log(`Checking for key ${key}...`);
        // I will just do a general search or check likely tables like users
        const [users] = await connection.execute(`SELECT * FROM users WHERE api_key = '${key}' LIMIT 1`).catch(() => [[]]);
        if (users.length > 0) {
            console.log('Found in users table:', users);
        } else {
            console.log('Not found in users table.');
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await connection.end();
    }
}

checkApiKey();
