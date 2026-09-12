/**
 * Quiz grading and the `edu_quiz` tool: the part of education mode that proves
 * understanding instead of assuming it.
 *
 * The grading functions are pure — questions and answers in, verdicts out — so
 * the score, the weak-point list, and the quiz-log entry are one computation
 * rather than three copies of the same rules.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFile } from "./store.js";
import { courseLayout, renderQuizSection, stamp } from "./paths.js";
/** Normalize a label or typed answer for comparison. */
function normalize(value) {
    return value
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^["'“”‘’(（\[]+|["'“”‘’)\]）]+$/g, '')
        .replace(/[.。,，;；:：!！?？]+$/g, '')
        .toLowerCase();
}
/**
 * Grade one quiz.
 *
 * Rules, in one place so the model can rely on them:
 * - a single-select question is correct when the answer matches ANY declared
 *   acceptable label (a typed answer is compared too, so variants can list);
 * - a multi-select question needs exactly the declared set; a non-empty proper
 *   subset scores half;
 * - a question with no options is never auto-graded: the model judges it, so it
 *   is reported as `needs_review` and left out of the score;
 * - an answer with neither a selection nor text is `skipped`, and still counts
 *   toward the denominator.
 *
 * @param questions The asked questions, in order.
 * @param answers The answers the learner gave.
 * @param passRatio Fraction in `0..1` that counts as passed.
 * @returns Verdicts, counts, score, and the weak points to re-teach.
 */
export function gradeQuiz(questions, answers, passRatio) {
    const byId = new Map(answers.map(answer => [answer.id, answer]));
    const outcomes = questions.map((question) => {
        const answer = byId.get(question.id);
        const selected = answer?.selected ?? [];
        const custom = answer?.custom?.trim() ?? '';
        const expected = [...question.answer];
        const base = {
            id: question.id,
            question: question.question,
            expected,
            selected,
            custom,
            explanation: question.explanation ?? '',
        };
        /** No answer at all. */
        if (selected.length === 0 && custom === '') {
            return { ...base, verdict: 'skipped', responded: '(no answer)' };
        }
        // An open question is the model's to judge, not this function's.
        if (question.options === undefined || question.options.length === 0) {
            const responded = custom === '' ? selected.join(', ') : custom;
            return { ...base, verdict: 'needs_review', responded };
        }
        if (question.multiSelect === true) {
            if (custom !== '') {
                // Free text over selected labels: only the model can judge intent.
                return { ...base, verdict: 'needs_review', responded: custom };
            }
            const expectedSet = new Set(expected.map(normalize));
            const selectedSet = new Set(selected.map(normalize));
            const responded = selected.join(', ');
            if (selectedSet.size === expectedSet.size && [...selectedSet].every(label => expectedSet.has(label))) {
                return { ...base, verdict: 'correct', responded };
            }
            const subset = selectedSet.size > 0 && [...selectedSet].every(label => expectedSet.has(label));
            return { ...base, verdict: subset ? 'partial' : 'incorrect', responded };
        }
        // Single select: an explicit "other" answer overrides the selection.
        const responded = custom === '' ? selected[0] : custom;
        const acceptable = new Set(expected.map(normalize));
        const verdict = acceptable.has(normalize(responded)) ? 'correct' : 'incorrect';
        return { ...base, verdict, responded };
    });
    const count = (verdict) => outcomes.filter(outcome => outcome.verdict === verdict).length;
    const correct = count('correct');
    const partial = count('partial');
    const incorrect = count('incorrect');
    const skipped = count('skipped');
    const needsReview = count('needs_review');
    const gradable = outcomes.filter(outcome => outcome.expected.length > 0 && outcome.verdict !== 'needs_review').length;
    const score = gradable === 0 ? undefined : (correct + partial * 0.5) / gradable;
    return {
        outcomes,
        gradable,
        correct,
        partial,
        incorrect,
        skipped,
        needsReview,
        score,
        passed: score === undefined ? undefined : score >= passRatio,
        weakPoints: outcomes.filter(outcome => outcome.verdict !== 'correct').map(outcome => outcome.question),
    };
}
/** Model-facing rendering of one graded quiz. */
export function renderQuizResult(topic, result, logPath) {
    const lines = [];
    const percent = result.score === undefined ? 'nothing auto-gradable' : `${Math.round(result.score * 100)}%`;
    lines.push(`Quiz "${topic}": ${result.correct}/${result.gradable} correct (${percent})${result.passed === true ? ' — passed' : result.passed === false ? ' — needs review' : ''}`);
    lines.push('');
    for (const outcome of result.outcomes) {
        const mark = outcome.verdict === 'correct'
            ? 'correct'
            : outcome.verdict === 'partial'
                ? 'partial credit'
                : outcome.verdict === 'skipped'
                    ? 'skipped'
                    : outcome.verdict === 'needs_review'
                        ? 'your judgement needed'
                        : 'incorrect';
        const parts = [`- [${mark}] ${outcome.question}`, `  answered: ${outcome.responded}`];
        if (outcome.verdict !== 'correct' && outcome.expected.length > 0)
            parts.push(`  expected: ${outcome.expected.join(' / ')}`);
        if (outcome.explanation !== '')
            parts.push(`  explanation: ${outcome.explanation}`);
        lines.push(parts.join('\n'));
    }
    if (result.needsReview > 0) {
        lines.push('');
        lines.push(`${result.needsReview} question(s) were answered in free text: judge each answer yourself against the reference answer and say whether it is right, then correct it if not.`);
    }
    lines.push('');
    lines.push('Next: explain every incorrect or partial answer in full, re-teach each weak point with a DIFFERENT explanation and a NEW example, then re-quiz those points with new questions. Do not re-ask questions the learner already answered correctly.');
    lines.push(`Quiz log: ${logPath}`);
    return lines.join('\n');
}
/** Format the learner's answer for the quiz log. */
function logEntry(outcome) {
    return {
        question: outcome.question,
        verdict: outcome.verdict,
        responded: outcome.responded,
        ...outcome.expected.length === 0 ? {} : { expected: outcome.expected.join(' / ') },
    };
}
/** Error codes the interaction channel reports when the learner walks away. */
const CANCELLED_CODES = new Set(['ASK_CANCELLED']);
/**
 * Error codes meaning "no human can be asked here": no UI provider is
 * registered, no question reached it, or the caller is a delegated/owned agent
 * with no answerer. Each degrades to handing the questions back to the model
 * rather than failing the call.
 */
const NO_CHANNEL_CODES = new Set(['NO_PROVIDER', 'EMPTY_QUESTIONS', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER']);
/**
 * Register `edu_quiz`.
 *
 * @param ctx Plugin context holding `ctx.tools`.
 * @param deps Quiz dependencies.
 */
export function registerQuizTool(ctx, deps) {
    ctx.tools.register(defineTool({
        name: 'edu_quiz',
        description: 'Ask the learner a graded quiz about what you just taught, in the conversation\'s own question UI, '
            + 'and record the result in the course quiz log. Call it at the end of every lesson, before claiming the learner '
            + 'understands anything. Supply options plus the acceptable answer label(s) for auto-graded questions '
            + '(single-select unless multiSelect is true; for single select, list every acceptable label in `answer`). '
            + 'Omit options for open questions: the learner answers in free text and the result marks those as needing your '
            + 'own judgement. Never reveal the answer before the learner answers.',
        parameters: {
            topic: { type: 'string', required: true, description: 'What this quiz tests, e.g. "特征值与特征向量".' },
            questions: {
                type: 'array',
                required: true,
                description: 'The questions, in order. Mix recall, application, and one transfer question.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        question: { type: 'string', required: true, description: 'The question itself, self-contained.' },
                        options: { type: 'array', items: { type: 'string' }, description: 'Choice labels. Omit for an open question.' },
                        answer: { type: 'array', items: { type: 'string' }, required: true, description: 'Acceptable answer label(s); for an open question, the reference answer.' },
                        explanation: { type: 'string', description: 'Why the answer is right, shown in the grading feedback.' },
                        multiSelect: { type: 'boolean', description: 'True when several labels must be selected together.' },
                    },
                },
            },
            course: { type: 'string', description: 'Course name. Defaults to the active course of education mode.' },
            passRatio: { type: 'number', description: 'Fraction of the auto-graded score that counts as passed, 0..1. Defaults to the plugin configured value.' },
            note: { type: 'string', description: 'One line for the quiz log, e.g. what to review next.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: { type: 'string', required: true, enum: ['graded', 'dismissed', 'no_channel'] },
                    course: { type: 'string', required: true },
                    topic: { type: 'string', required: true },
                    gradable: { type: 'number', required: true },
                    correct: { type: 'number', required: true },
                    partial: { type: 'number', required: true },
                    incorrect: { type: 'number', required: true },
                    skipped: { type: 'number', required: true },
                    needsReview: { type: 'number', required: true },
                    score: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                    passed: { required: true, oneOf: [{ type: 'boolean' }, { type: 'null' }] },
                    weakPoints: { type: 'array', required: true, items: { type: 'string' } },
                    results: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                question: { type: 'string', required: true },
                                verdict: { type: 'string', required: true, enum: ['correct', 'partial', 'incorrect', 'skipped', 'needs_review'] },
                                expected: { type: 'array', required: true, items: { type: 'string' } },
                                selected: { type: 'array', required: true, items: { type: 'string' } },
                                custom: { type: 'string', required: true },
                                responded: { type: 'string', required: true },
                                explanation: { type: 'string', required: true },
                            },
                        },
                    },
                    logPath: { type: 'string', description: 'Workspace-relative quiz-log path, absent when nothing was logged.' },
                    guidance: { type: 'string', required: true, description: 'What to do with this result.' },
                },
            },
            render: (_args, value) => {
                if (value.status === 'no_channel') {
                    return [{ type: 'text', text: noChannelText(value.topic) }];
                }
                if (value.status === 'dismissed') {
                    return [{ type: 'text', text: `The learner dismissed the "${value.topic}" quiz to say something instead. Stop the quiz, read their message, and answer it — do not re-ask the quiz unless they ask for it.` }];
                }
                const result = {
                    outcomes: value.results.map(row => ({
                        id: row.id,
                        question: row.question,
                        verdict: row.verdict,
                        expected: row.expected,
                        selected: row.selected,
                        custom: row.custom,
                        responded: row.responded,
                        explanation: row.explanation,
                    })),
                    gradable: value.gradable,
                    correct: value.correct,
                    partial: value.partial,
                    incorrect: value.incorrect,
                    skipped: value.skipped,
                    needsReview: value.needsReview,
                    score: value.score ?? undefined,
                    passed: value.passed ?? undefined,
                    weakPoints: value.weakPoints,
                };
                return [{ type: 'text', text: renderQuizResult(value.topic, result, value.logPath ?? '(not logged)') }];
            },
        },
        execute: async (args, exec) => {
            const questions = normalizeQuestions(args.questions, deps.maxQuestions);
            const course = args.course?.trim() || deps.activeCourse(exec.agent);
            if (course === undefined) {
                throw new Error('edu_quiz needs a course: pass `course`, or open one first with edu_course');
            }
            const passRatio = resolvePassRatio(args.passRatio, deps.passRatio);
            const interaction = ctx.get('userQuestions');
            if (interaction === undefined)
                return noChannelResult(questions, course, args.topic);
            const request = {
                questions: questions.map((question) => ({
                    id: question.id,
                    header: args.topic,
                    question: question.question,
                    ...question.options === undefined || question.options.length === 0
                        ? {}
                        : { options: question.options.map(label => ({ label })) },
                    ...question.multiSelect === true ? { multiSelect: true } : {},
                })),
                ...exec.agent === undefined ? {} : { agent: exec.agent },
                signal: exec.signal,
            };
            let answer;
            try {
                answer = await interaction.ask(request);
            }
            catch (error) {
                const code = error.code ?? '';
                // The learner took the turn back to speak: not a failed tool call.
                if (CANCELLED_CODES.has(code))
                    return dismissedResult(course, args.topic);
                // No human can answer here (no UI provider, or a delegated caller):
                // hand the questions back instead of failing the call.
                if (NO_CHANNEL_CODES.has(code))
                    return noChannelResult(questions, course, args.topic);
                throw error;
            }
            const graded = gradeQuiz(questions, answer.answers, passRatio);
            const date = stamp(deps.now());
            const section = renderQuizSection({
                topic: args.topic,
                score: graded.score,
                correct: graded.correct,
                gradable: graded.gradable,
                passed: graded.passed,
                entries: graded.outcomes.map(logEntry),
                ...args.note === undefined ? {} : { note: args.note },
                date,
            });
            const store = deps.store();
            let logPath;
            if (store !== undefined) {
                const { file } = await appendFile(store, courseLayout(deps.notesDir, course).quizzes, `${section}\n`, `# ${course} · quizzes\n\nQuiz history kept by dsh-edu-mode education mode.\n\n`, exec);
                logPath = file.path;
            }
            return {
                status: 'graded',
                course,
                topic: args.topic,
                gradable: graded.gradable,
                correct: graded.correct,
                partial: graded.partial,
                incorrect: graded.incorrect,
                skipped: graded.skipped,
                needsReview: graded.needsReview,
                score: graded.score ?? null,
                passed: graded.passed ?? null,
                weakPoints: graded.weakPoints,
                results: graded.outcomes.map(outcome => ({
                    id: outcome.id,
                    question: outcome.question,
                    verdict: outcome.verdict,
                    expected: [...outcome.expected],
                    selected: [...outcome.selected],
                    custom: outcome.custom,
                    responded: outcome.responded,
                    explanation: outcome.explanation,
                })),
                ...logPath === undefined ? {} : { logPath },
                guidance: graded.weakPoints.length === 0
                    ? 'Everything answered correctly: confirm the mastery in one sentence, then propose the next topic or module.'
                    : 'Re-teach the weak points with different explanations and new examples, then re-quiz only those points.',
            };
        },
    }));
}
/** Text returned when no interactive question channel is composed. */
function noChannelText(topic) {
    return `No interactive question channel is available, so the "${topic}" quiz could not be asked directly. `
        + 'Put the questions to the learner in your own message, wait for their answers, and grade them yourself — '
        + 'do not treat this as a completed quiz.';
}
/**
 * The result returned when the questions could not be put to a human. Every
 * question is reported as `skipped` with its reference answer, so the model can
 * run the quiz in chat without losing anything.
 *
 * @param questions The validated questions.
 * @param course The course the quiz belongs to.
 * @param topic What the quiz tests.
 * @returns The canonical no-channel outcome.
 */
function noChannelResult(questions, course, topic) {
    return {
        status: 'no_channel',
        course,
        topic,
        gradable: questions.length,
        correct: 0,
        partial: 0,
        incorrect: 0,
        skipped: 0,
        needsReview: questions.length,
        score: null,
        passed: null,
        weakPoints: [],
        results: questions.map(question => ({
            id: question.id,
            question: question.question,
            verdict: 'skipped',
            expected: [...question.answer],
            selected: [],
            custom: '',
            responded: '',
            explanation: question.explanation ?? '',
        })),
        guidance: 'No interactive question channel is available: put these questions to the learner in chat, wait for their answers, and grade them yourself.',
    };
}
/**
 * The result returned when the learner dismissed the quiz to speak instead.
 *
 * @param course The course the quiz belongs to.
 * @param topic What the quiz tests.
 * @returns The canonical dismissed outcome.
 */
function dismissedResult(course, topic) {
    return {
        status: 'dismissed',
        course,
        topic,
        gradable: 0,
        correct: 0,
        partial: 0,
        incorrect: 0,
        skipped: 0,
        needsReview: 0,
        score: null,
        passed: null,
        weakPoints: [],
        results: [],
        guidance: 'The learner dismissed the quiz to speak instead; answer whatever they say.',
    };
}
/** Validate and identify the questions before they reach the interaction channel. */
function normalizeQuestions(raw, maxQuestions) {
    if (raw.length === 0)
        throw new Error('edu_quiz needs at least one question');
    if (raw.length > maxQuestions) {
        throw new Error(`edu_quiz accepts at most ${maxQuestions} questions at a time; split the quiz into rounds`);
    }
    return raw.map((question, index) => {
        const id = `q${index + 1}`;
        const text = question.question.trim();
        if (text === '')
            throw new Error(`${id}: every quiz question needs non-empty text`);
        const options = question.options?.map(option => option.trim()).filter(option => option !== '');
        const answer = question.answer.map(label => label.trim()).filter(label => label !== '');
        if (answer.length === 0)
            throw new Error(`${id}: every quiz question needs at least one acceptable answer`);
        if (question.multiSelect === true && (options === undefined || options.length === 0)) {
            throw new Error(`${id}: multiSelect requires options`);
        }
        if (options !== undefined && options.length > 0) {
            const known = new Set(options);
            for (const label of answer) {
                if (!known.has(label)) {
                    throw new Error(`${id}: answer "${label}" is not one of the options; single-select questions accept any listed label`);
                }
            }
        }
        return {
            id,
            question: text,
            ...options === undefined || options.length === 0 ? {} : { options },
            answer,
            ...question.explanation === undefined || question.explanation.trim() === ''
                ? {}
                : { explanation: question.explanation.trim() },
            ...question.multiSelect === true ? { multiSelect: true } : {},
        };
    });
}
/** Clamp a model-supplied pass ratio. */
function resolvePassRatio(requested, fallback) {
    if (requested === undefined)
        return fallback;
    if (!Number.isFinite(requested) || requested <= 0 || requested > 1) {
        throw new Error('passRatio must be a fraction greater than 0 and at most 1');
    }
    return requested;
}
