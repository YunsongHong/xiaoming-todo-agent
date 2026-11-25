import OpenAI from "openai";
import { intentSchema } from "./intent.ts";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}

export async function interpretMessage(message: string) {
  const response = await getModelClient().chat.completions.create(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            '你是中文待办意图分类器，只返回一个 JSON 对象。新增用 {"action":"create","title":"任务标题"}，保留原文中的日期。查询用 {"action":"list","filter":"all"}，filter 可选 all、open、done、today（仅今天到期）、overdue（已逾期）。完成或删除用 {"action":"complete","target":"任务关键词"} 或 {"action":"delete","target":"任务关键词"}。只提取明确指令，遇到否定、假设、多项操作、指代不明、能力之外的问题或闲聊，返回 {"action":"help"}。不要声称已执行。',
        },
        { role: "user", content: message },
      ],
      response_format: { type: "json_object" },
    },
    { timeout: 12000, maxRetries: 0 },
  );
  return intentSchema.parse(JSON.parse(response.choices[0]?.message.content ?? "{}"));
}
