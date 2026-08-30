/**
 * Shared resume constants — single source of truth for both the hub (which
 * serves the default to the dashboard editor and falls back to it during AI
 * polish) and the gateway (whose deterministic `buildSummary` implements what
 * this text describes). Editing this text changes what the dashboard shows
 * everywhere; keep it in sync with the gateway's summary template.
 */

/** Hard cap for a custom resume prompt — keeps hub.json and resume.md bounded. */
export const RESUME_PROMPT_MAX_LENGTH = 8000;

/**
 * 系统默认简历生成提示词 — the default instructions for how the agent should
 * write its resume. The audience is the coordinating agent (and other peers):
 * the resume exists so a dispatcher can decide which tasks to hand over.
 * Pre-filled in the dashboard's prompt editor when the operator has not saved
 * a custom prompt, and used as the AI-polish fallback so polish works before
 * any prompt is configured. Operators customize it to pin down a role the
 * workspace scan cannot infer.
 */
export const DEFAULT_RESUME_PROMPT = [
  '这份简历的读者是协调 agent：它根据简历判断应该把什么任务交给你。',
  '请用简洁的中文总结你负责的工作：正在承担的职责、能独立完成的任务类型（例如跑测试并修复失败用例、改动后保持构建通过、按 lint 规则清理代码等），突出可交付的成果。',
  '只基于工作区中真实存在的事实（项目、语言、框架、构建/测试脚本、Git 状态），不要编造项目、技术栈或经历。',
  '如果从工作区判断不出你适合承担的角色，就如实描述当前的工作内容，具体角色由用户在自定义提示词中指定。',
].join('\n');
