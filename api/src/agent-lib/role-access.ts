/**
 * Role Access Matrix — Single source of truth for permissions
 *
 * Controls who can see what data. Every permission check flows through here.
 * Edit ONE place to change access rules.
 */

// ── Role definitions ──
export const ROLES = {
    SUPER_ADMIN: 1,
    ADMIN: 2,
    COLLEGE_ADMIN: 3,
    STAFF: 4,
    TRAINER: 5,
    CONTENT_CREATOR: 6,
    STUDENT: 7,
} as const;

// ── Permission groups ──
export const GROUPS = {
    PLATFORM_ADMIN: [1, 2] as readonly number[],      // See everything
    COLLEGE_SCOPED: [3, 4, 5] as readonly number[],   // See their college only
    PERSONAL_ONLY: [6, 7] as readonly number[],       // See own data only
};

// ── Data access rules ──
export const ACCESS = {
    PERSONAL_DATA: {
        description: "Own coding, MCQ, courses, test scores",
        allowedRoles: [1, 2, 3, 4, 5, 6, 7],
    },
    VIEW_STUDENTS: {
        description: "View other students' data",
        allowedRoles: [1, 2, 3, 4, 5],
    },
    TOP_STUDENTS: {
        description: "Top/ranked students",
        allowedRoles: [1, 2, 3, 4, 5],
    },
    SEARCH_USERS: {
        description: "Search users by name/email",
        allowedRoles: [1, 2, 3, 4, 5],
    },
    STUDENT_COUNT: {
        description: "Count students",
        allowedRoles: [1, 2, 3, 4, 5],
    },
    COLLEGE_COMPARISON: {
        description: "Compare colleges",
        allowedRoles: [1, 2, 3],
    },
    PLATFORM_STATS: {
        description: "Platform-wide statistics",
        allowedRoles: [1, 2],
    },
    ALL_COURSES: {
        description: "View all courses",
        allowedRoles: [1, 2, 3, 4, 5],
    },
} as const;

export type Permission = keyof typeof ACCESS;

// ── Helper functions ──

export function canAccess(roleNum: number, permission: Permission): boolean {
    return (ACCESS[permission].allowedRoles as readonly number[]).includes(roleNum);
}

export function getScope(roleNum: number): "platform" | "college" | "personal" {
    if (GROUPS.PLATFORM_ADMIN.includes(roleNum)) return "platform";
    if (GROUPS.COLLEGE_SCOPED.includes(roleNum)) return "college";
    return "personal";
}

export function isStudent(roleNum: number): boolean {
    return roleNum === ROLES.STUDENT;
}

export function isPlatformAdmin(roleNum: number): boolean {
    return GROUPS.PLATFORM_ADMIN.includes(roleNum);
}

export function isCollegeScoped(roleNum: number): boolean {
    return GROUPS.COLLEGE_SCOPED.includes(roleNum);
}

export function getRoleName(roleNum: number): string {
    const names: Record<number, string> = {
        1: "SuperAdmin", 2: "Admin", 3: "CollegeAdmin",
        4: "Staff", 5: "Trainer", 6: "Content Creator", 7: "Student",
    };
    return names[roleNum] || "Unknown";
}

// ══════════════════════════════════════════════════════════════════════════════
// RESTRICTED ACCESS CHECK — For questions about OTHER users' data
// ══════════════════════════════════════════════════════════════════════════════

export function checkRestrictedAccess(
    question: string,
    userRole: number,
): { allowed: boolean; reason?: string } {
    const q = question.toLowerCase();
    const roleName = getRoleName(userRole);

    if (/(?:all|list|show|every)\s*students?/.test(q) && !canAccess(userRole, "VIEW_STUDENTS")) {
        return { allowed: false, reason: `${roleName} cannot view student lists` };
    }
    if (/(?:topper|top\s*\d+|best|highest|rank)/.test(q) && !canAccess(userRole, "TOP_STUDENTS")) {
        return { allowed: false, reason: `${roleName} cannot view top students` };
    }
    if (/(?:search|find)\s*(?:user|student)/.test(q) && !canAccess(userRole, "SEARCH_USERS")) {
        return { allowed: false, reason: `${roleName} cannot search users` };
    }
    if (/(?:student\s*count|how many\s*students?)/.test(q) && !canAccess(userRole, "STUDENT_COUNT")) {
        return { allowed: false, reason: `${roleName} cannot view student counts` };
    }
    if (/(?:compare|vs).*college/.test(q) && !canAccess(userRole, "COLLEGE_COMPARISON")) {
        return { allowed: false, reason: `${roleName} cannot compare colleges` };
    }
    if (/(?:platform|overall|system).*(?:stat|report)/.test(q) && !canAccess(userRole, "PLATFORM_STATS")) {
        return { allowed: false, reason: `${roleName} cannot view platform stats` };
    }

    return { allowed: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// SQL SCOPE BUILDER — Constructs WHERE clause based on role
// ══════════════════════════════════════════════════════════════════════════════

export function getSQLScope(
    userRole: number,
    userId: number,
    collegeId: number | null,
): { whereClause: string; description: string } {
    const scope = getScope(userRole);
    switch (scope) {
        case "platform":
            return { whereClause: "1=1", description: "All colleges, all data" };
        case "college":
            return {
                whereClause: collegeId ? `college_id = ${collegeId}` : "1=1",
                description: `Scoped to college_id = ${collegeId}`,
            };
        case "personal":
        default:
            return {
                whereClause: `user_id = ${userId}`,
                description: `Scoped to user_id = ${userId}`,
            };
    }
}

/**
 * Provides a user-friendly explanation of why data is limited based on their role.
 */
export function getScopeDescription(roleNum: number): string {
    const scope = getScope(roleNum);
    const roleName = getRoleName(roleNum);

    switch (scope) {
        case "platform":
            return `As ${roleName}, you have access to platform-wide statistics and data from all colleges.`;
        case "college":
            return `As ${roleName}, your view is scoped to your assigned college. You can see statistics and student data within your institution.`;
        case "personal":
        default:
            if (roleNum === ROLES.STUDENT) {
                return `As a Student, you can view your own performance, scores, and enrolled courses. You don't have access to other students' private data.`;
            }
            return `Your access is currently limited to your personal data.`;
    }
}
/**
 * TABLE_SCOPE_MAP — Overrides for specific tables that don't follow user_id/college_id defaults.
 */
export const TABLE_SCOPE_MAP: Record<string, { isPublicCatalog?: boolean; hasUserId?: boolean; userColumn?: string }> = {
    // Public catalog tables — no user_id filter needed
    'certificates': { isPublicCatalog: true },
    'courses': { isPublicCatalog: true },
    'colleges': { isPublicCatalog: true },
    'departments': { isPublicCatalog: true },
    'batches': { isPublicCatalog: true },
    'languages': { isPublicCatalog: true },
    'compilers': { isPublicCatalog: true },
    'practice_modules': { isPublicCatalog: true },
    'topics': { isPublicCatalog: true },
    'sections': { isPublicCatalog: true },
    'course_academic_maps': { isPublicCatalog: true },
    'institutions': { isPublicCatalog: true },
    'question_banks': { isPublicCatalog: true },
    'discussions': { isPublicCatalog: true },
    'tests': { isPublicCatalog: true },

    // User data tables — require user_id filter
    'verify_certificates': { hasUserId: true, userColumn: 'user_id' },
    'portal_feedback': { hasUserId: true, userColumn: 'user_id' },
    'user_academics': { hasUserId: true, userColumn: 'user_id' },
    'course_wise_segregations': { hasUserId: true, userColumn: 'user_id' },
    'user_course_enrollments': { hasUserId: true, userColumn: 'user_id' },
    'a_i_high_lights': { hasUserId: true, userColumn: 'user_id' },
};
