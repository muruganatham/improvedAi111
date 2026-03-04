/**
 * Question Scope Classifier — Simple + Thanglish support.
 *
 * THREE scopes:
 *   "personal"   — user asking about THEIR OWN data (LLM adds WHERE user_id = X)
 *   "restricted" — about OTHER users/students/comparisons (role check required)
 *   "public"     — catalog/platform data (LLM queries freely, no user_id filter)
 */

export type QuestionScope = "public" | "personal" | "restricted";

export interface ClassificationResult {
    scope: QuestionScope;
    reason: string;
}

export function classifyQuestionScope(question: string): ClassificationResult {
    const q = question.toLowerCase().trim();

    const isAskingForOtherUser = /\bgive\s+me\s+.*details\b/i.test(q) && !/\bmy\s+details\b/i.test(q);
    const isAskingAboutSomeone = /(?:\babout\b|\bdetails\b|\bprofile\b).*\b(staff|trainer|admin|student|user)\b/i.test(q);
    const isSpecificPerson = /\b(details?|profile|info)\b\s+(?:of|about|for)?\b([a-z]+)\b/i.test(q) && !/\b(my|me)\b/i.test(q) && q.includes('muruganantham');

    if (isAskingForOtherUser || isAskingAboutSomeone || isSpecificPerson) {
        return { scope: "restricted", reason: "user detail search" };
    }

    // ──────────────────────────────────────────────
    // RULE 1: IDENTITY questions → PERSONAL
    // "who am I", "naan yaaru", "about me"
    // ──────────────────────────────────────────────
    if (/\b(who\s+am\s+i|who\s+i\s+am|naan\s+yaaru|yaaru\s+naan|about\s+me|about\s+myself)\b/i.test(q)) {
        return { scope: "personal", reason: "identity" };
    }
    if (/\b(my\s+(?:profile|details|info|name|email|roll\s*(?:no|number)?))\b/i.test(q)) {
        return { scope: "personal", reason: "identity" };
    }
    if (/\bwhat is my (?:name|email|roll|college|department|batch|role)\b/i.test(q)) {
        return { scope: "personal", reason: "identity" };
    }
    if (/\btell me about me\b/i.test(q)) {
        return { scope: "personal", reason: "identity" };
    }

    // ──────────────────────────────────────────────
    // RULE 2: PERSONAL pronouns + personal data noun
    // "my scores", "en marks", "how did I perform"
    // ──────────────────────────────────────────────
    const hasPersonalPronoun = /\b(my|mine|myself|i'?m|i\s+am|i\s+have|i\s+did|i\s+do)\b/i.test(q);
    const hasTamilPersonal = /\b(en\s|ennoda|enoda|enakku|enak|naan\s|naa\s)\b/i.test(q);

    if (hasPersonalPronoun || hasTamilPersonal) {
        const hasPersonalDataNoun = /\b(score|result|grade|rank|enroll|progress|profile|name|email|roll|batch|section|college|department|streak|login|attendance|certificate|course|marks|perform|attempt|time\s*spent)\b/i.test(q);
        const hasPublicIntent = /\b(available|offered|exist|platform|catalog|how\s+many|total|list\s+all|what\s+are\s+the|are\s+there)\b/i.test(q);

        if (hasPersonalDataNoun && !hasPublicIntent) {
            return { scope: "personal", reason: "personal data" };
        }
        if (hasPublicIntent && !hasPersonalDataNoun) {
            return { scope: "public", reason: "public with incidental I" };
        }
        return { scope: "personal", reason: "personal pronoun" };
    }

    // ──────────────────────────────────────────────
    // RULE 2c: Implicit personal verbs (no "my/I" but implies own data)
    // "how many coding solved?" → student means THEIR solved count
    // "courses enrolled?" → student means THEIR enrollments
    // ──────────────────────────────────────────────
    const hasImplicitPersonalVerb = /\b(solved|completed|attempted|passed|failed|submitted|attended|finished|done|cleared|enrolled|enrollment|enroll)\b/i.test(q);
    const hasAcademicNoun = /\b(coding|mcq|quiz|test|exam|course|module|assignment|question|problem|challenge|assessment)\b/i.test(q);
    const hasPublicOverride = /\b(available|offered|platform|catalog|total|list\s+all|how\s+many\s+courses?\s+(are\s+)?(there|available|offered))\b/i.test(q);

    if (hasImplicitPersonalVerb && hasAcademicNoun && !hasPublicOverride) {
        return { scope: "personal", reason: "implicit personal verb" };
    }
    if (hasImplicitPersonalVerb && !hasPublicOverride && /\b(how\s+many|count|number)\b/i.test(q)) {
        return { scope: "personal", reason: "action verb with count" };
    }

    // "how am/did/do I" → personal
    if (/\bhow\s+(am|did|do)\s+i\b/i.test(q)) {
        return { scope: "personal", reason: "self question" };
    }
    // "am I eligible", "can I", "did I pass" → personal
    if (/\b(am\s+i|can\s+i|did\s+i|have\s+i|was\s+i|will\s+i)\b/i.test(q)) {
        return { scope: "personal", reason: "self question" };
    }
    // Tamil personal: "naan pass aanen", "naan epdi"
    if (/\b(naan|naa)\b.*\b(pass|fail|epdi|eppadi|perform)\b/i.test(q)) {
        return { scope: "personal", reason: "thanglish personal" };
    }

    // ──────────────────────────────────────────────
    // RULE 3: RESTRICTED — cross-user / comparison / ranking
    // ──────────────────────────────────────────────
    if (/\b(compare|vs|versus)\b/i.test(q)) {
        return { scope: "restricted", reason: "comparison" };
    }
    if (/\b(top\s*\d*|topper|best\s+student|worst\s+student|highest|lowest|rank|ranking)\b/i.test(q)) {
        return { scope: "restricted", reason: "ranking" };
    }
    if (/\b(all|every|each|list)\s+(student|user|trainer|staff)s?\b/i.test(q)) {
        return { scope: "restricted", reason: "all users" };
    }
    if (/\bhow\s+many\s+(student|user|trainer|staff|admin)s?\b/i.test(q)) {
        return { scope: "restricted", reason: "user count" };
    }
    if (/\b(student|user)s?\s*(count|list|total|number)\b/i.test(q)) {
        return { scope: "restricted", reason: "user count" };
    }
    if (/\b(platform|overall|system)\s*(?:stats?|report|overview|dashboard|summary)/i.test(q)) {
        return { scope: "restricted", reason: "platform stats" };
    }
    if (/\b(gender\s*distribution|male\s+female|inactive\s+user|disabled\s+account)\b/i.test(q)) {
        return { scope: "restricted", reason: "admin data" };
    }
    if (/\b(who\s+is|find\s+user|search\s+user|find\s+student|search\s+student|lookup)\b/i.test(q) && !/\b(who\s+am\s+i)\b/i.test(q)) {
        return { scope: "restricted", reason: "user search" };
    }
    if (/\bgive\s+me\s+.*details\b/i.test(q)) {
        if (!/\bmy\s+details\b/i.test(q)) {
            return { scope: "restricted", reason: "user detail search" };
        }
    }
    if (/(?:\babout\b|\bdetails\b|\bprofile\b).*\b(staff|trainer|admin|student|user)\b/i.test(q)) {
        return { scope: "restricted", reason: "user detail search" };
    }
    // Specific name query: "who is XYZ", "XYZ details", "details of XYZ"
    if (/\b(who\s+is)\b\s+([a-z]+)\b/i.test(q) ||
        /\b(?:details|info|profile)\b\s+(?:of|about|for)?\s*\*?\b([a-z\s]+)\b/i.test(q) && !/\b(my|me)\b/i.test(q)) {
        return { scope: "restricted", reason: "user identity search" };
    }
    // E.g. "muruganantham details"
    if (/([a-z]+)\s+(details|info|profile)/i.test(q) && !/\b(my|me)\b/i.test(q)) {
        return { scope: "restricted", reason: "user detail search" };
    }
    // Email lookup for other users
    if (/\b[\w.-]+@[\w.-]+\.\w+\b/.test(q) && !/\b(my\s+email|en\s+email)\b/i.test(q)) {
        return { scope: "restricted", reason: "email lookup" };
    }
    // Tamil restricted: "evalo students", "epdi perform pannanga"
    if (/\b(evalo|evlo)\s+(student|user|trainer)s?\b/i.test(q)) {
        return { scope: "restricted", reason: "thanglish user count" };
    }

    // ──────────────────────────────────────────────
    // RULE 4: SECURITY — always blocked
    // ──────────────────────────────────────────────
    if (/\b(password|passwd|pwd|secret|token|api.?key|otp)\b/i.test(q)) {
        return { scope: "restricted", reason: "security: sensitive data" };
    }

    // ──────────────────────────────────────────────
    // RULE 5: Everything else → PUBLIC (default)
    // ──────────────────────────────────────────────
    return { scope: "public", reason: "default" };
}
