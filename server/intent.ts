import { z } from "zod";

export const intentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("list"), filter: z.enum(["all", "open", "done", "today"]) }),
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
  // A question, negation or compound instruction should never fall through to a local write.
  if (
    /^(别|不要|不用|暂不)|还没|没(有)?完成|[，,。；;](?:再|然后|并|删除|完成|添加|新增|帮我)|[？?]|[吗么呢]$|然后|并且/u.test(
      text,
    )
  ) {
    return listQuery(text);
  }
  const create =
    /^(?:请)?(?:小明[，, ]*)?(?:请)?(?:帮我|给我)?(?:再)?(?:提醒我|记一下|记下|记一条|记上|加一条|加一个|添加|新增|创建)(?:一个待办|一条待办|待办事项|待办|任务)?[：:\s]*(.+)$/u.exec(
      text,
    );
  if (create) return { action: "create", title: create[1].trim() };
  const command = text.replace(/^(?:请)?(?:帮我)?(?:把|将)?/u, "").replace(/(?:吧|一下)$/u, "");
  const deletion =
    /^(?:删除|删掉|移除)\s*(.+)$/u.exec(command) ??
    /^(.+?)(?:这条任务|这条|这个任务)?(?:删除|删掉|移除)$/u.exec(command);
  if (deletion) return { action: "delete", target: deletion[1].trim() };
  const complete =
    /^(?:完成|勾选)\s*(.+)$/u.exec(command) ??
    /^(.+?)(?:这条任务|这条)?(?:标记为已完成|标为完成|已完成|完成了|做完了|搞定了)$/u.exec(command);
  if (complete) return { action: "complete", target: complete[1].trim() };
  // Chinese allows both 买牛奶 and 牛奶买好了. Reconstruct the verb-object title.
  const result = /^(.+?)([买洗取交写寄发修领付拿])(?:好|完|到|过)了$/u.exec(command);
  if (result) return { action: "complete", target: result[2] + result[1] };
  return listQuery(text);
}

function listQuery(text: string): Intent | undefined {
  if (/^(?:待办|任务|清单)[？?]?$/u.test(text)) return { action: "list", filter: "all" };
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
