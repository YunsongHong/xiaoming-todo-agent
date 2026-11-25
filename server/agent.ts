import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { parseIntent, type Intent } from "./intent.ts";
import type { Task, TaskStore } from "./task-store.ts";

const help =
  "你可以说「帮我记一下明天交报告」「我有哪些任务？」「完成交报告」或「删除交报告」。说「今天有哪些任务到期？」可以查看今天截止的待办。";
const dateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function calendarDate(now: Date, offset = 0) {
  const midnight = new Date(dateFormatter.format(now) + "T00:00:00Z");
  midnight.setUTCDate(midnight.getUTCDate() + offset);
  return midnight.toISOString().slice(0, 10);
}

function addTask(tasks: TaskStore, input: string, now: Date) {
  const prefix = /^(今天|明天|后天|\d{4}-\d{2}-\d{2})\s*/u.exec(input);
  let title = input.slice(prefix?.[0].length ?? 0).trim();
  // 「明天的会议」 and 「明天要交报告」: the connective belongs to the date, not the title.
  if (prefix) title = title.replace(/^(?:的(?!士)|需要|要(?![求点闻素]))\s*/u, "");
  if (!title || title.length > 200) return "请给我一个 1 至 200 字的任务标题。";
  let dueDate: string | undefined;
  if (prefix) {
    const offset = ["今天", "明天", "后天"].indexOf(prefix[1]);
    dueDate = offset < 0 ? prefix[1] : calendarDate(now, offset);
    if (!z.iso.date().safeParse(dueDate).success) return "这个日期无效，请用 YYYY-MM-DD 重新输入。";
  }
  const existing = tasks.list().find((t) => !t.done && t.title === title && t.dueDate === dueDate);
  if (existing) return "「" + title + "」已经在待办清单里了。";
  const task = tasks.create(title, dueDate);
  return "已添加「" + task.title + "」" + (task.dueDate ? "，截止 " + task.dueDate : "") + "。";
}

function taskLine(task: Task) {
  return " · " + task.title + (task.dueDate ? "（" + task.dueDate + " 截止）" : "");
}

function listTasks(
  tasks: Task[],
  filter: Extract<Intent, { action: "list" }>["filter"],
  today: string,
) {
  if (filter === "overdue") {
    const overdue = tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today);
    return overdue.length
      ? ["已逾期（" + overdue.length + "）", ...overdue.map(taskLine)].join("\n")
      : "没有逾期的待办。";
  }
  const open = tasks.filter((t) => !t.done && (filter !== "today" || t.dueDate === today));
  if (filter === "today")
    return open.length
      ? ["今天到期（" + open.length + "）", ...open.map(taskLine)].join("\n")
      : "今天没有到期的待办。";
  const done = tasks.filter((t) => t.done);
  if (filter === "all" && !tasks.length) return "清单是空的。你可以说「帮我记一下买牛奶」。";
  const groups: string[] = [];
  if (filter !== "done")
    groups.push(["待办（" + open.length + "）", ...open.map(taskLine)].join("\n"));
  if (filter !== "open")
    groups.push(["已完成（" + done.length + "）", ...done.map(taskLine)].join("\n"));
  return groups.join("\n\n");
}

function changeTask(tasks: TaskStore, action: "complete" | "delete", target: string) {
  if (!target) return help;
  const all = tasks.list();
  const exact = all.filter((t) => t.title === target);
  let matches = exact.length ? exact : all.filter((t) => t.title.includes(target));
  if (!exact.length && target.startsWith("#"))
    matches = all.filter((t) => t.id === target.slice(1));
  // 取、拿、领 describe the same errand; try them only when the user's own verb finds nothing.
  if (action === "complete" && !matches.length && /^[取拿领]./u.test(target)) {
    const variants = [..."取拿领"].map((verb) => verb + target.slice(1));
    matches = all.filter((t) => variants.some((variant) => t.title.includes(variant)));
  }
  // A finished task that was added again should not compete with its open copy.
  if (action === "complete" && matches.every((t) => t.title === matches[0].title)) {
    const open = matches.filter((t) => !t.done);
    if (open.length) matches = open;
  }
  if (!matches.length) return "没找到「" + target + "」。可以先说「看看清单」核对标题。";
  if (matches.length > 1) {
    const command = action === "delete" ? "删除" : "完成";
    return [
      "有多条匹配，请回复“第2个”这样的序号，或复制对应指令：",
      ...matches.map((t, index) => {
        const title = t.title.replace(/\s+/gu, " ");
        const due = t.dueDate ? `（${t.dueDate}）` : "";
        const status = t.done ? "已完成" : "待办";
        return `${index + 1}. ${title}${due}［${status}］ → ${command} #${t.id}`;
      }),
    ].join("\n");
  }
  const [task] = matches;
  if (action === "delete" && tasks.remove(task.id)) return "已删除「" + task.title + "」。";
  if (action === "complete") {
    if (task.done) return "「" + task.title + "」已经完成了。";
    if (tasks.update(task.id, { done: true })) return "已完成「" + task.title + "」。";
  }
  return "这条任务已发生变化，请再看一下清单。";
}

type Interpreter = (message: string) => Promise<Intent>;
export function createAgent(tasks: TaskStore, interpret?: Interpreter, now = () => new Date()) {
  return async function reply(messages: ChatMessage[]) {
    const input = messages.at(-1)?.content.trim() ?? "";
    const selection = /^第?([1-9]\d*|[一二三四五六七八九十])(?:个|项|条)?[。！]?$/u.exec(input);
    const previous = messages.at(-2);
    if (
      selection &&
      previous?.role === "assistant" &&
      previous.content.startsWith("有多条匹配，请回复")
    ) {
      const ordinal = Number(selection[1]) || "一二三四五六七八九十".indexOf(selection[1]) + 1;
      const choice = previous.content.split("\n").find((line) => line.startsWith(ordinal + ". "));
      const command = / → (删除|完成) #(\S+)$/u.exec(choice ?? "");
      if (!command) return previous.content;
      return changeTask(tasks, command[1] === "删除" ? "delete" : "complete", "#" + command[2]);
    }
    let intent = parseIntent(input);
    if (!intent && interpret) {
      try {
        intent = await interpret(input);
      } catch {
        return "暂时无法理解这句话。" + help;
      }
      // Model proposals require an explicit, locally parseable command before any write.
      if (
        intent.action === "create" ||
        intent.action === "complete" ||
        intent.action === "delete"
      ) {
        const verbs = { create: "添加", complete: "完成", delete: "删除" };
        const title = intent.action === "create" ? intent.title : intent.target;
        return `如果我理解正确，请发送「${verbs[intent.action]} ${title}」确认。`;
      }
    }
    switch (intent?.action) {
      case "create":
        return addTask(tasks, intent.title, now());
      case "list":
        return listTasks(tasks.list(), intent.filter, calendarDate(now()));
      case "complete":
      case "delete":
        return changeTask(tasks, intent.action, intent.target);
      default:
        return help;
    }
  };
}
