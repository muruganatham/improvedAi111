import { findMatchingTemplate } from "./src/agent-lib/query-templates";

console.log("TESTING RAG TEMPLATE MATCHING:\n");

const q1 = "who are the top 5 best performing students in srec?";
console.log("Question 1:", q1);
console.log(findMatchingTemplate(q1));

const q2 = "can you show me the score analysis for student 12345?";
console.log("Question 2:", q2);
console.log(findMatchingTemplate(q2));

const q3 = "how many students are there in kits?";
console.log("Question 3:", q3);
console.log(findMatchingTemplate(q3));
