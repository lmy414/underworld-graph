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

  /**
   * 释放资源（no-op）。
   *
   * EventLog 当前无内部状态（appendFileSync/readFileSync 直接操作路径），
   * 但为与 WorldGraph.close() 的资源语义对称提供此方法。未来若改用文件流
   * 或句柄，此处释放对应资源。
   */
  close(): void {
    // 当前实现无状态，无需释放
  }
}
