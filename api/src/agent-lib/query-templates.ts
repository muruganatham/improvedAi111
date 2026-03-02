export const QUERY_TEMPLATES = [
    {
        name: "top_students",
        keywords: ["top", "best", "performing", "rank", "leaderboard", "highest", "topper"],
        description: "Use this template when asking for the top N students across a college or course.",
        template: `WITH all_tests AS (
    SELECT user_id,
           JSON_EXTRACT(mark, '$.co') AS co_mark,
           JSON_EXTRACT(total_mark, '$.co') AS co_total,
           JSON_EXTRACT(mark, '$.mcq') AS mcq_mark,
           JSON_EXTRACT(total_mark, '$.mcq') AS mcq_total
    FROM {college}_{year1}_{sem1}_test_data WHERE status = 1
    UNION ALL
    SELECT user_id,
           JSON_EXTRACT(mark, '$.co'),
           JSON_EXTRACT(total_mark, '$.co'),
           JSON_EXTRACT(mark, '$.mcq'),
           JSON_EXTRACT(total_mark, '$.mcq')
    FROM {college}_{year2}_{sem2}_test_data WHERE status = 1
)
SELECT u.name, u.register_no,
       ROUND(SUM(co_mark)/NULLIF(SUM(co_total),0)*100, 2) AS coding_pct,
       ROUND(SUM(mcq_mark)/NULLIF(SUM(mcq_total),0)*100, 2) AS mcq_pct,
       ROUND((SUM(co_mark) + SUM(mcq_mark)) / NULLIF(SUM(co_total) + SUM(mcq_total), 0) * 100, 2) AS overall_pct
FROM all_tests t
JOIN users u ON t.user_id = u.id
GROUP BY t.user_id, u.name, u.register_no
ORDER BY overall_pct DESC
LIMIT 5;`,
        required_columns: ["name", "coding_pct", "mcq_pct", "overall_pct"]
    },
    {
        name: "student_analysis",
        keywords: ["analysis", "performance", "weak", "strong", "breakdown", "score of"],
        description: "Use this template when analyzing a specific student's performance.",
        template: `SELECT 
    JSON_EXTRACT(mark, '$.co') AS coding_score,
    JSON_EXTRACT(total_mark, '$.co') AS coding_total,
    JSON_EXTRACT(mark, '$.mcq') AS mcq_score,
    JSON_EXTRACT(total_mark, '$.mcq') AS mcq_total
FROM {college}_{year}_{sem}_test_data t
JOIN users u ON t.user_id = u.id
WHERE u.email = '{email}' OR u.register_no = '{register_no}' AND t.status = 1;`,
        required_columns: ["coding_score", "coding_total", "mcq_score", "mcq_total"]
    }
];

export function findMatchingTemplate(question: string): string {
    const lowerQ = question.toLowerCase();
    let bestMatch = null;
    let maxScore = 0;

    for (const template of QUERY_TEMPLATES) {
        let score = 0;
        for (const kw of template.keywords) {
            if (lowerQ.includes(kw)) score++;
        }
        if (score > maxScore) {
            maxScore = score;
            bestMatch = template;
        }
    }

    if (!bestMatch) return "";

    return `\n### RECOMMENDED QUERY TEMPLATE: ${bestMatch.name}\n${bestMatch.description}\n\`\`\`sql\n${bestMatch.template}\n\`\`\`\n`;
}
