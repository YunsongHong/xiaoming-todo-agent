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

test("口语完成说法命中原任务，否定和将要发生的说法不改状态", async (t) => {
  const { say, tasks } = await setup(t);
  for (const [title, said] of [
    ["买牛奶", "我把牛奶买好了"],
    ["买鸡蛋", "鸡蛋买了"],
    ["买面包", "买完面包了"],
    ["取快递", "快递拿到了"],
    ["取包裹", "包裹取回来了"],
    ["洗衣服", "我已经把衣服洗好了"],
    ["写摘要", "摘要写好了"],
  ]) {
    const task = tasks.create(title);
    await say(said);
    assert.equal(tasks.list().find((item) => item.id === task.id)?.done, true, said);
  }
  const open = [tasks.create("买水果"), tasks.create("交快递费"), tasks.create("写报告")];
  for (const said of ["水果不买了", "水果没买", "快交了", "报告快写完了", "水果买不到了"]) {
    await say(said);
    for (const task of open)
      assert.equal(tasks.list().find((item) => item.id === task.id)?.done, false, said);
  }
});

test("近义动词不会抢走标题一致的任务", async (t) => {
  const { say, tasks } = await setup(t);
  const take = tasks.create("拿快递");
  const fetch = tasks.create("取快递");
  await say("快递拿到了");
  assert.deepEqual(
    tasks.list().map((task) => [task.id, task.done]),
    [
      [take.id, true],
      [fetch.id, false],
    ],
  );
});

test("询问清单不会误建任务，口语新增保留完整标题", async (t) => {
  const { say, tasks } = await setup(t);
  for (const said of ["新增了什么任务", "新增了什么任务？", "提醒我有哪些任务", "添加了哪些待办"]) {
    assert.match(await say(said), /清单是空的|^待办（0）$/u, said);
    assert.equal(tasks.list().length, 0, said);
  }
  for (const [said, title, dueDate] of [
    ["记得洗衣服", "洗衣服", undefined],
    ["帮我记录一下倒垃圾", "倒垃圾", undefined],
    ["帮我记一下明天的会议", "会议", "2027-01-02"],
    ["帮我记一下明天要交报告", "交报告", "2027-01-02"],
    ["帮我记一下今天的士预约", "的士预约", "2027-01-01"],
    ["提醒我什么时候交作业", "什么时候交作业", undefined],
  ]) {
    await say(said!);
    const task = tasks.list().at(-1);
    assert.deepEqual([task?.title, task?.dueDate], [title, dueDate], said);
  }
});

test("取消即删除，指代不明或取消标题时不误删", async (t) => {
  const { say, tasks } = await setup(t);
  tasks.create("取快递");
  await say("取消取快递");
  assert.equal(tasks.list().length, 0);
  const keep = tasks.create("了解保险");
  for (const said of ["取消了", "取消掉", "删掉了", "取消", "取消完成了解保险"]) {
    await say(said);
    assert.deepEqual(tasks.list(), [keep], said);
  }
  const cancel = tasks.create("取消会员");
  await say("取消会员搞定了");
  assert.equal(tasks.list().find((task) => task.id === cancel.id)?.done, true);
});

test("逾期查询只列已过截止日的未完成任务", async (t) => {
  const { say, tasks } = await setup(t);
  assert.match(await say("有什么逾期的任务"), /没有逾期/u);
  tasks.create("交水费", "2026-12-31");
  tasks.create("交电费", "2027-01-01");
  tasks.create("无日期");
  const paid = tasks.create("交房租", "2026-12-30");
  tasks.update(paid.id, { done: true });
  for (const said of ["有什么逾期的任务", "有逾期的任务吗？", "哪些待办过期了"])
    assert.equal(await say(said), "已逾期（1）\n · 交水费（2026-12-31 截止）", said);
});

test("重新添加的同名任务可直接完成，标题不同时仍要求选择", async (t) => {
  const { say, tasks } = await setup(t);
  for (let round = 0; round < 2; round++) {
    await say("帮我记一下买牛奶");
    await say("牛奶买好了");
  }
  assert.deepEqual(
    tasks.list().map((task) => task.done),
    [true, true],
  );
  const weekly = tasks.create("交周报告");
  tasks.update(weekly.id, { done: true });
  const project = tasks.create("交项目报告");
  assert.match(await say("完成报告"), /有多条匹配/u);
  assert.equal(tasks.list().find((task) => task.id === project.id)?.done, false);
});
