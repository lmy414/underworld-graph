import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { EventRecord } from "./types.js";
import type { EventRecordInput } from "./types.js";

/**
 * EventLog — JSONL append-only 事件日志（飞书文档"步骤 3"）
 * 每行一个 EventRecord JSON
 * traceBack 沿 causedBy 字段回溯因果链
 */
export class EventLog {
  constructor(private readonly path: string) {}

  async append(input: EventRecordInput): Promise<void> {
    // parse 应用默认值（source 缺省 "engine"），日志行始终是完整 EventRecord
    const line = JSON.stringify(EventRecord.parse(input)) + "\n";
    appendFileSync(this.path, line, "utf-8");
  }

  async readAll(): Promise<EventRecord[]> {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EventRecord);
  }

  async traceBack(eventId: string): Promise<EventRecord[]> {
    const all = await this.readAll();
    const byId = new Map(all.map((e) => [e.eventId, e]));
    const chain: EventRecord[] = [];
    let cur = byId.get(eventId);
    while (cur) {
      chain.unshift(cur);
      const causedBy = cur.causedBy;
      cur = causedBy ? byId.get(causedBy) : undefined;
    }
    return chain;
  }
}
