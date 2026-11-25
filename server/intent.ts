import { z } from "zod";

export const intentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().trim().min(1).max(200) }),
  z.object({
    action: z.literal("list"),
    filter: z.enum(["all", "open", "done", "today", "overdue"]),
  }),
  z.object({ action: z.literal("complete"), target: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("delete"), target: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("help") }),
]);
export type Intent = z.infer<typeof intentSchema>;

export function parseIntent(input: string): Intent | undefined {
  const text = input
    .trim()
    .replace(/[。！!]+$/u, "")
    .trim();
  if (/^(你好|您好|帮助|小明|怎么用)[？?]?$/u.test(text)) return { action: "help" };
  // 「新增了什么任务」 asks about the list even though it starts like a creation.
  if (
    /^(?:请)?(?:提醒我|添加|新增|创建)了?(?:还)?有?(?:哪些|什么|啥)(?!时候).*(?:任务|待办|事项)[？?]?$/u.test(
      text,
    )
  ) {
    return listQuery(text) ?? { action: "list", filter: "all" };
  }
  // A question, negation or compound instruction should never fall through to a local write.
  if (
    /^(别|不要|不用|暂不)|还没|没(有)?完成|[，,。；;](?:再|然后|并|删除|完成|添加|新增|帮我)|[？?]|[吗么呢]$|然后|并且/u.test(
      text,
    )
  ) {
    return listQuery(text);
  }
  const create =
    /^(?:请)?(?:小明[，, ]*)?(?:请)?(?:帮我|给我)?(?:再)?(?:提醒我|记得|记录一下|记一下|记下|记一条|记上|加一条|加一个|添加|新增|创建)(?:一个待办|一条待办|待办事项|待办|任务)?[：:\s]*(.+)$/u.exec(
      text,
    );
  if (create) return { action: "create", title: create[1].trim() };
  const command = text
    .replace(/^(?:请)?(?:帮我)?(?:我(?=把|将|已经|刚))?(?:已经|刚刚|刚)?(?:把|将)?/u, "")
    .replace(/(?:吧|一下)$/u, "");
  // Particles and pronouns left after the verb do not name a task.
  if (/^(?:删除|删掉|移除|取消)(?:掉|了|掉了|它|这个|那个|这条|那条)$/u.test(command)) return;
  const deletion =
    /^(?:删除|删掉|移除)\s*(.+)$/u.exec(command) ??
    /^(.+?)(?:这条任务|这条|这个任务)?(?:删除|删掉|移除)$/u.exec(command);
  if (deletion) return { action: "delete", target: deletion[1].trim() };
  const complete =
    /^(?:完成|勾选)\s*(.+)$/u.exec(command) ??
    /^(.+?)(?:这条任务|这条)?(?:标记为已完成|标为完成|已完成|完成了|做完了|搞定了)$/u.exec(command);
  if (complete) return { action: "complete", target: complete[1].trim() };
  // Chinese allows both 买牛奶 and 牛奶买好了. Reconstruct the verb-object title.
  const objectFirst = /^(.+?)([买洗取交写寄发修领付拿])(?:好|完|到|过|回来)?了$/u.exec(command);
  if (objectFirst) {
    // 「牛奶不买了」 and 「报告快写完了」 do not report a finished task.
    if (/(?:不|没|没有|别|未|快|想|准备|打算)$/u.test(objectFirst[1])) return;
    return { action: "complete", target: objectFirst[2] + objectFirst[1] };
  }
  const verbFirst = /^([买洗取交写寄发修领付拿])(?:好|完|到)(.+)了$/u.exec(command);
  if (verbFirst) return { action: "complete", target: verbFirst[1] + verbFirst[2] };
  // After completion, so that 「取消会员搞定了」 finishes that task instead of deleting it.
  const cancel =
    /^取消(?!完成|勾选|标记)\s*(.+)$/u.exec(command) ??
    /^(.+?)(?:这条任务|这条|这个任务)?取消(?:了|掉)?$/u.exec(command);
  if (cancel) return { action: "delete", target: cancel[1].trim() };
  return listQuery(text);
}

function listQuery(text: string): Intent | undefined {
  if (/^(?:待办|任务|清单)[？?]?$/u.test(text)) return { action: "list", filter: "all" };
  if (/(?:逾期|过期|超期)/u.test(text) && /(?:待办|任务|事项|清单|哪些|什么|看看|列出)/u.test(text))
    return /[没未不]/u.test(text) ? undefined : { action: "list", filter: "overdue" };
  if (
    !/(?:今天|今日|待办|任务|清单|事项|完成|要做|要办)/u.test(text) ||
    !/(?:看看|查看|显示|列出|哪些|有什么|还有什么|清单$|什么.*到期)/u.test(text)
  )
    return;
  if (/(?:到期|截止)/u.test(text)) {
    if (!/(?:今天|今日)/u.test(text)) return;
    return { action: "list", filter: "today" };
  }
  if (/(?:未完成|待完成|没完成|还[要需]|待办[？?]?$|要做|要办)/u.test(text))
    return { action: "list", filter: "open" };
  if (/(?:已完成|做完)/u.test(text)) return { action: "list", filter: "done" };
  return { action: "list", filter: "all" };
}
