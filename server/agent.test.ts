import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function setup(t: TestContext, interpret?: Parameters<typeof createAgent>[1]) {
  const directory = await mkdtemp(join(tmpdir(), "xiaoming-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const tasks = createJsonTaskStore(filename);
  // Already Jan 1 in Shanghai, still Dec 31 in UTC.
  const reply = createAgent(tasks, interpret, () => new Date("2026-12-31T16:01:00Z"));
  const history: ChatMessage[] = [];
  async function say(content: string) {
    history.push({ role: "user", content });
    const answer = await reply(history);
    history.push({ role: "assistant", content: answer });
    return answer;
  }
  return { say, tasks, filename };
}

test("题面六轮对话与重开存储后的清单一致", async (t) => {
  const { say, tasks, filename } = await setup(t);
  await say("帮我记一下买牛奶");
  await say("再记一条取快递");
  assert.match(await say("我有哪些任务？"), /待办（2）\n · 买牛奶\n · 取快递/u);
  await say("牛奶买好了");
  assert.deepEqual(
    tasks.list().map((task) => task.done),
    [true, false],
  );
  await say("取快递这条删掉吧");
  assert.equal(await say("再给我看看清单"), "待办（0）\n\n已完成（1）\n · 买牛奶");
  const restarted = createAgent(createJsonTaskStore(filename));
  assert.match(await restarted([{ role: "user", content: "清单" }]), /已完成（1）\n · 买牛奶/u);
});

test("洗衣服示例、重复新增、否定和未命中", async (t) => {
  const { say, tasks } = await setup(t);
  await say("帮我记一下洗衣服");
  await say("提醒我洗衣服");
  assert.equal(tasks.list().length, 1);
  await say("衣服还没洗好");
  await say("不要删除洗衣服");
  await say("洗衣服完成了吗？");
  await say("完成整理衣服");
  assert.equal(tasks.list()[0].done, false);
  await say("衣服洗好了");
  assert.equal(tasks.list()[0].done, true);
  assert.match(await say("完成洗衣服"), /已经完成/u);
});

test("歧义时按上一轮的稳定 ID 选择，期间列表可以变化", async (t) => {
  const { say, tasks } = await setup(t);
  const first = tasks.create("交项目报告");
  const second = tasks.create("交周报告");
  const question = await say("删除报告");
  assert.ok(question.includes(first.id) && question.includes(second.id));
  assert.equal(tasks.list().length, 2);
  tasks.remove(first.id);
  const third = tasks.create("交月报告");
  await say("第二个");
  assert.deepEqual(tasks.list(), [third]);
});

test("按上海自然日筛选截止日期，旧任务、已完成任务和无效日期", async (t) => {
  const { say, tasks } = await setup(t);
  tasks.create("无日期");
  await say("新增今天交报告");
  await say("新增明天买票");
  await say("新增2027-02-30 开会");
  assert.deepEqual(
    tasks.list().map((task) => task.dueDate),
    [undefined, "2027-01-01", "2027-01-02"],
  );
  const today = await say("今天有哪些任务到期？");
  assert.match(today, /交报告/u);
  assert.doesNotMatch(today, /买票|无日期/u);
  await say("完成交报告");
  assert.match(await say("今天有哪些任务到期？"), /没有到期/u);
});

test("可选模型的写入建议须经确认，模型故障后基础对话可用", async (t) => {
  const { say, tasks } = await setup(t, async (text) => {
    if (text === "服务异常") throw Error("offline");
    return { action: "create", title: "取蛋糕" };
  });
  assert.match(await say("生日蛋糕得去拿一趟，帮忙记着"), /请发送「添加 取蛋糕」确认/u);
  assert.equal(tasks.list().length, 0);
  await say("添加 取蛋糕");
  assert.match(await say("服务异常"), /暂时无法理解/u);
  assert.match(await say("看看清单"), /取蛋糕/u);
});
