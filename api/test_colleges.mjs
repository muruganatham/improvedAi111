import mysql from 'mysql2/promise';

async function run() {
    try {
        const conn = await mysql.createConnection({
            host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
            port: 4000,
            user: 'jJH5hBme2DUVaP7.root',
            password: '78Pisbo61VCw2K9i',
            database: 'coderv4',
            ssl: {
                rejectUnauthorized: true
            }
        });

        const query = `
      SELECT u.id, u.name, c.college_name, c.college_short_name, SUM(cws.score) as total_score
      FROM users u
      JOIN user_academics ua ON u.id = ua.user_id
      JOIN colleges c ON ua.college_id = c.id
      JOIN course_wise_segregations cws ON u.id = cws.user_id
      GROUP BY u.id, u.name, c.college_name, c.college_short_name
      ORDER BY total_score DESC
      LIMIT 10
    `;
        const [rows] = await conn.query(query);
        console.log("Top 10 Students College Data:", rows);

        conn.end();
    } catch (e) { console.error(e); }
}
run();
