export const SMART_TABLE_REGISTRY = {
    "table_patterns": {
        "test_data": {
            "pattern": "{college}_{year}_{semester}_test_data",
            "description": "Student test scores per college/semester",
            "json_columns": {
                "mark": { "$.co": "coding_score", "$.mcq": "mcq_score", "$.pro": "project_score" },
                "total_mark": { "$.co": "coding_total", "$.mcq": "mcq_total", "$.pro": "project_total" },
                "report_metrics": { "$.err_den": "error_density", "$.att_eff": "attempt_efficiency" }
            },
            "key_joins": "JOIN users u ON t.user_id = u.id",
            "filters": "WHERE status = 1"
        },
        "coding_result": {
            "pattern": "{college}_{year}_{semester}_coding_result",
            "description": "Detailed coding submission results/scores"
        },
        "mcq_result": {
            "pattern": "{college}_{year}_{semester}_mcq_result",
            "description": "Detailed MCQ submission results/scores"
        }
    },
    "colleges": {
        "srec": { "college_id": 6, "name": "Sri Ramakrishna Engineering College" },
        "skcet": { "college_id": 1, "name": "Sri Krishna College of Engineering and Technology" },
        "skct": { "college_id": 8, "name": "SKCT" },
        "kits": { "college_id": 2, "name": "Karunya Institute of Technology and Sciences" },
        "mcet": { "college_id": 7, "name": "MCET" },
        "niet": { "college_id": 9, "name": "NIET" },
        "kclas": { "college_id": 10, "name": "KCLAS" },
        "ciet": { "college_id": 11, "name": "CIET" }
    }
};

export function getSmartRegistryContext(): string {
    return `\n### SMART TABLE REGISTRY (Metadata)\n\`\`\`json\n${JSON.stringify(SMART_TABLE_REGISTRY, null, 2)}\n\`\`\`\n`;
}
