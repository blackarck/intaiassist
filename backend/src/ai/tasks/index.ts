import { assist } from "./assist.js";
import { nextQuestions } from "./nextQuestions.js";
import { openingQuestions } from "./openingQuestions.js";
import { scoreAnswer } from "./scoreAnswer.js";
import { scorecard } from "./scorecard.js";
import type { TaskDef } from "./types.js";

export const TASKS = { opening_questions: openingQuestions, next_questions: nextQuestions, assist, score_answer: scoreAnswer, scorecard } as const;
export type TaskName = keyof typeof TASKS;
export const taskNames = Object.keys(TASKS) as TaskName[];
export const getTask = (name: string): TaskDef<any, any> | undefined => (TASKS as Record<string, TaskDef<any, any>>)[name];
export { FinalizeError } from "./types.js";
