/**
 * Education mode for DeepSeek Harness.
 *
 * While the mode is active the plugin contributes a deployment-owned guidance
 * section to every model request — gather real sources, teach the material,
 * write the class notes down, and prove understanding with a quiz — plus the
 * tools that make the guidance enforceable rather than aspirational:
 *
 * - `edu_course` opens the course and owns the syllabus/module checklist,
 * - `edu_notes` writes the class notes for one lesson,
 * - `edu_quiz` asks the learner a graded quiz in the conversation's own
 *   question UI and logs the result.
 *
 * State is per-session and lives in the session log (`edu/mode`, last one
 * wins), so a resumed or forked session restores the mode — and its course —
 * from the log alone, with no live mirror. `/edu` is the human switch.
 *
 * @module dsh-edu-mode
 */
import { Service } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { registerCourseTools } from "./course.js";
import { renderDefaultPolicy } from "./policy.js";
import { registerQuizTool } from "./quiz.js";
import { createNoteStore } from "./store.js";
/** Placeholder accepted by {@link resolveConfig} when the loader passes none. */
const EMPTY_CONFIG = {};
/**
 * Validate deployment configuration. Unknown keys and unusable values fail at
 * plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config = EMPTY_CONFIG) {
    const unknown = Object.keys(config).filter(key => !['policy', 'notesDir', 'maxQuizQuestions', 'passRatio'].includes(key));
    if (unknown.length > 0) {
        throw new Error(`EduModeConfig has unknown key(s) ${unknown.join(', ')} — config is { policy, notesDir, maxQuizQuestions, passRatio }`);
    }
    const notesDir = (config.notesDir ?? 'edu-notes').trim().replace(/[\\/]+$/, '');
    if (notesDir === '')
        throw new Error('EduModeConfig needs a non-empty `notesDir`');
    if (/^[a-zA-Z]:/.test(notesDir) || notesDir.startsWith('/') || notesDir.split(/[\\/]+/).includes('..')) {
        throw new Error('EduModeConfig `notesDir` must be a workspace-relative path inside the session workspace');
    }
    if (config.policy !== undefined && config.policy.trim() === '') {
        throw new Error('EduModeConfig `policy` must be non-empty when present (omit it to use the built-in teaching protocol)');
    }
    const maxQuizQuestions = config.maxQuizQuestions ?? 6;
    if (!Number.isInteger(maxQuizQuestions) || maxQuizQuestions < 1 || maxQuizQuestions > 20) {
        throw new Error('EduModeConfig `maxQuizQuestions` must be an integer between 1 and 20');
    }
    const passRatio = config.passRatio ?? 0.8;
    if (!Number.isFinite(passRatio) || passRatio <= 0 || passRatio > 1) {
        throw new Error('EduModeConfig `passRatio` must be a fraction greater than 0 and at most 1');
    }
    return {
        ...config.policy === undefined ? {} : { policy: config.policy },
        notesDir,
        maxQuizQuestions,
        passRatio,
    };
}
/**
 * Fold the logged education-mode state. The last `edu/mode` wins; a prefix with
 * none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns The state in force.
 */
export function foldEduMode(events, end = events.length) {
    let state = { active: false };
    let index = 0;
    for (const event of events) {
        if (index >= end)
            break;
        index++;
        if (event.type !== 'edu/mode')
            continue;
        state = event.data.course === undefined
            ? { active: event.data.active }
            : { active: event.data.active, course: event.data.course };
    }
    return state;
}
/** Whether two states describe the same mode and course. */
function sameState(left, right) {
    return left.active === right.active && (left.course ?? '') === (right.course ?? '');
}
/** Serialize a state into the log's JSON shape (never carrying an explicit `undefined`). */
function stateData(state) {
    return state.course === undefined ? { active: state.active } : { active: state.active, course: state.course };
}
/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events) {
    let open = false;
    for (const event of events) {
        if (event.type === 'turn/start')
            open = true;
        else if (event.type === 'turn/end')
            open = false;
    }
    return open;
}
/** Education state at the last logged request header, or `undefined` before the first header. */
function modeAtLastHeader(events) {
    let lastHeader = -1;
    let index = 0;
    for (const event of events) {
        if (event.type === 'request/header')
            lastHeader = index;
        index++;
    }
    if (lastHeader < 0)
        return undefined;
    return foldEduMode(events, lastHeader + 1);
}
/**
 * `ctx.eduMode`: owns the logged education-mode state, its guidance section, the
 * `/edu` command, and the course/notes/quiz tools.
 */
export class EduMode extends Service {
    static inject = ['tools', 'systemPrompt'];
    /** Validated configuration with defaults applied. */
    config;
    /** Guidance rendered as the `edu:policy` prompt section while the mode is active. */
    policy;
    /**
     * Latest selection per session awaiting the next accepted in-turn pre-step.
     * A tool call or command running inside an open turn must not append to the
     * log, so its selection waits for the step boundary.
     */
    pendingIntents = new WeakMap();
    constructor(ctx, config = EMPTY_CONFIG) {
        super(ctx, 'eduMode');
        this.config = resolveConfig(config);
        this.policy = this.config.policy ?? renderDefaultPolicy({
            notesDir: this.config.notesDir,
            maxQuizQuestions: this.config.maxQuizQuestions,
        });
        // Pre-step is outside Session.append publication, so the log-only mode
        // event can be appended inside an open turn without re-entering the session.
        ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
            const decision = await next();
            const pending = this.pendingIntents.get(agent.session);
            if (decision.kind === 'reject' || signal.aborted || pending === undefined)
                return decision;
            const narration = this.narration(agent.session, pending);
            try {
                this.onBoundary(agent.session);
            }
            catch (error) {
                ctx.logger.warn('dsh-edu-mode: failed to append the selected education mode at step start: %o', error);
                return decision;
            }
            return narration === undefined ? decision : { ...decision, messages: [...decision.messages, narration] };
        });
        ctx.systemPrompt.section({
            name: 'edu:policy',
            order: 51,
            text: (context) => {
                if (context.agent === undefined)
                    return '';
                const state = this.effective(context.agent.session);
                if (!state.active)
                    return '';
                return state.course === undefined
                    ? this.policy
                    : `${this.policy}\n\n# Active course\n\n${state.course}\n\nKeep every course file and every quiz pointed at this course.`;
            },
        });
        // The course tools need a filesystem; the mode itself does not, so they
        // activate as an optional child and a composition without `fs` keeps the
        // mode and the quiz working.
        let store;
        ctx.inject(['fs'], (fsCtx) => {
            const activeStore = createNoteStore(fsCtx);
            store = activeStore;
            registerCourseTools(fsCtx, {
                store: activeStore,
                notesDir: this.config.notesDir,
                activeCourse: agent => this.courseOf(agent),
                setCourse: (agent, course) => { this.setCourse(agent, course); },
                now: () => new Date(),
            });
            ctx.logger.debug('dsh-edu-mode: course tools registered');
        });
        registerQuizTool(ctx, {
            maxQuestions: this.config.maxQuizQuestions,
            passRatio: this.config.passRatio,
            notesDir: this.config.notesDir,
            // Read lazily: the fs child may activate after this plugin.
            store: () => store,
            activeCourse: agent => this.courseOf(agent),
            now: () => new Date(),
        });
        ctx.inject(['commands'], (commandCtx) => {
            commandCtx.commands.register({
                name: 'edu',
                description: 'Enter or leave education mode',
                input: { hint: '[off|status|course]', images: true },
                handler: ({ agent, rawInput, attachments }) => {
                    const message = rawInput.trim();
                    if (message === 'off') {
                        if (attachments.length > 0) {
                            return { kind: 'error', text: 'Image attachments cannot accompany /edu off.' };
                        }
                        switch (this.set(agent, { active: false })) {
                            case 'committed':
                                return { kind: 'success', text: 'Education mode off.' };
                            case 'queued':
                                return { kind: 'success', text: 'Leaving education mode (applies from the next step).' };
                            case 'cancelled':
                                return { kind: 'success', text: 'Education mode entry cancelled.' };
                            case 'noop':
                                return { kind: 'success', text: 'Education mode is already off.' };
                        }
                    }
                    if (message === 'status') {
                        const state = this.effective(agent.session);
                        return {
                            kind: 'success',
                            text: state.active
                                ? `Education mode is on${state.course === undefined ? '' : ` — course "${state.course}"`}. Notes go to ${this.config.notesDir}/. Use /edu off to leave.`
                                : 'Education mode is off. Use /edu <course> to start a course.',
                        };
                    }
                    const next = message === '' ? { active: true } : { active: true, course: message };
                    const outcome = this.set(agent, next);
                    if (message !== '' || attachments.length > 0) {
                        agent.steer(createUserMessage({
                            content: [
                                ...attachments,
                                ...(message === '' ? [] : [{ type: 'text', text: message }]),
                            ],
                            source: { kind: 'user' },
                        }));
                    }
                    const where = message === '' ? '' : ` for "${message}"`;
                    return {
                        kind: 'success',
                        text: outcome === 'noop'
                            ? `Education mode is already on${where}.`
                            : `Education mode on${where}: research it, teach it, write the class notes with edu_notes, then quiz with edu_quiz. Use /edu off to leave.`,
                    };
                },
            });
        });
    }
    /**
     * Read the effective state: a selection awaiting the next step boundary wins
     * over the logged state, so tools and the prompt section see the same answer
     * the user just asked for.
     *
     * @param session The session to read.
     * @returns The state the next request will use.
     */
    effective(session) {
        return this.pendingIntents.get(session) ?? foldEduMode(session.events);
    }
    /**
     * Read the mode state for one agent.
     *
     * @param agent The agent to read.
     * @returns The logged state plus any selection awaiting the next step.
     */
    get(agent) {
        const pending = this.pendingIntents.get(agent.session);
        return { ...this.effective(agent.session), ...pending === undefined ? {} : { pending: true } };
    }
    /**
     * The course the session is teaching, for the tools that default to it.
     *
     * @param agent The calling agent, when the call came from one.
     * @returns The course name, or `undefined` when none is set.
     */
    courseOf(agent) {
        if (agent === undefined)
            return undefined;
        return this.effective(agent.session).course;
    }
    /**
     * Record the canonical course name, activating the mode when it was off: a
     * learner who opens a course is studying it.
     *
     * @param agent The agent to switch.
     * @param course The canonical course name.
     * @returns What happened, exactly as {@link set} reports it.
     */
    setCourse(agent, course) {
        if (agent === undefined)
            return 'detached';
        return this.set(agent, { active: true, course });
    }
    /**
     * Select the education-mode state. Between turns the change is appended
     * immediately, because no in-turn pre-step will run until another prompt
     * starts a turn. During an open turn the selection waits for the next
     * accepted in-turn pre-step. Selecting the state already in force is a no-op.
     *
     * @param agent The agent to switch.
     * @param next The state to select.
     * @returns `committed` (logged now), `queued` (awaiting the next step),
     * `cancelled` (an opposite selection was dropped; the log already matches),
     * or `noop` (already in that state).
     */
    set(agent, next) {
        const session = agent.session;
        const targeted = this.effective(session);
        if (sameState(targeted, next))
            return 'noop';
        if (hasOpenTurn(session.events)) {
            if (sameState(foldEduMode(session.events), next)) {
                this.pendingIntents.delete(session);
                return 'cancelled';
            }
            this.pendingIntents.set(session, next);
            return 'queued';
        }
        // No open turn: commit now. Delete the pending entry only after a
        // successful append, so a failed durable write stays retryable.
        if (sameState(foldEduMode(session.events), next)) {
            this.pendingIntents.delete(session);
            return 'cancelled';
        }
        session.append('edu/mode', stateData(next));
        this.pendingIntents.delete(session);
        const narration = this.narration(session, next);
        if (narration !== undefined)
            agent.inject(narration);
        return 'committed';
    }
    /** Append one pending selection before the next request assembly. */
    onBoundary(session) {
        const pending = this.pendingIntents.get(session);
        if (pending === undefined)
            return;
        if (sameState(foldEduMode(session.events), pending)) {
            this.pendingIntents.delete(session);
            return;
        }
        session.append('edu/mode', stateData(pending));
        // Delete only after append succeeds so a later accepted in-turn pre-step
        // can retry a failed durable write.
        this.pendingIntents.delete(session);
    }
    /** Build a model-facing notice when the last logged header described another state. */
    narration(session, target) {
        const told = modeAtLastHeader(session.events);
        if (told === undefined || sameState(told, target))
            return undefined;
        const text = target.active
            ? `The user switched this session to education mode${target.course === undefined ? '' : ` for the course "${target.course}"`}.`
            : 'The user switched this session back to the default mode; education mode is off.';
        return createUserMessage({
            content: [{ type: 'text', text }],
            // Already one sentence, so it is its own summary.
            source: { kind: 'plugin', plugin: 'dsh-edu-mode', form: 'notice', summary: text },
        });
    }
}
export default EduMode;
