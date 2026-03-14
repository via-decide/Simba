import fs from "node:fs/promises";
import path from "node:path";

export class SimbaStateEngine {
  constructor(stateFilePath, maxHistory = 50) {
    this.stateFilePath = stateFilePath;
    this.maxHistory = maxHistory;
    this._writeLock = Promise.resolve();
  }

  static fromConfig(config) {
    const stateFilePath = path.join(config.artifactsDir, "simba-state.json");
    return new SimbaStateEngine(stateFilePath, config.maxTaskHistory);
  }

  /** Serialize all writes through a simple promise chain lock */
  _withLock(fn) {
    this._writeLock = this._writeLock.then(fn, fn);
    return this._writeLock;
  }

  async _load() {
    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return { chats: {} };
      throw error;
    }
  }

  async _save(state) {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const tmp = this.stateFilePath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, this.stateFilePath);
  }

  async upsertChatState(chatId, updater) {
    return this._withLock(async () => {
      const state = await this._load();
      const key = String(chatId);
      const current = state.chats[key] || {
        tasks: {},
        activeTaskId: null,
        pendingPreview: null,
        logs: []
      };
      state.chats[key] = updater(current);

      // Prune task history
      const tasks = state.chats[key].tasks;
      const taskIds = Object.keys(tasks);
      if (taskIds.length > this.maxHistory) {
        const sorted = taskIds.sort(
          (a, b) =>
            (tasks[a].timestamps?.startedAt || "") < (tasks[b].timestamps?.startedAt || "") ? -1 : 1
        );
        const toRemove = sorted.slice(0, taskIds.length - this.maxHistory);
        for (const id of toRemove) delete tasks[id];
      }

      await this._save(state);
      return state.chats[key];
    });
  }

  async setPendingPreview(chatId, preview) {
    return this.upsertChatState(chatId, (chat) => ({ ...chat, pendingPreview: preview }));
  }

  async clearPendingPreview(chatId) {
    return this.upsertChatState(chatId, (chat) => ({ ...chat, pendingPreview: null }));
  }

  async getChatState(chatId) {
    const state = await this._load();
    return state.chats[String(chatId)] || {
      tasks: {},
      activeTaskId: null,
      pendingPreview: null,
      logs: []
    };
  }

  async setTaskState(chatId, taskId, patch) {
    return this.upsertChatState(chatId, (chat) => {
      const existing = chat.tasks[taskId] || {};
      const merged = {
        ...existing,
        ...patch,
        timestamps: { ...(existing.timestamps || {}), ...(patch.timestamps || {}) }
      };
      return {
        ...chat,
        activeTaskId: taskId,
        tasks: { ...chat.tasks, [taskId]: merged }
      };
    });
  }

  async appendLog(chatId, entry) {
    return this.upsertChatState(chatId, (chat) => {
      const logs = [...(chat.logs || []), { ts: new Date().toISOString(), ...entry }];
      // Keep last 200 log lines
      return { ...chat, logs: logs.slice(-200) };
    });
  }

  async getLogs(chatId, count = 20) {
    const chat = await this.getChatState(chatId);
    return (chat.logs || []).slice(-count);
  }

  async getTask(chatId, taskId) {
    const chat = await this.getChatState(chatId);
    return chat.tasks[taskId] || null;
  }

  async getActiveTask(chatId) {
    const chat = await this.getChatState(chatId);
    if (!chat.activeTaskId) return null;
    return chat.tasks[chat.activeTaskId] || null;
  }

  async getTaskHistory(chatId, count = 10) {
    const chat = await this.getChatState(chatId);
    return Object.values(chat.tasks)
      .sort((a, b) =>
        (b.timestamps?.startedAt || "") > (a.timestamps?.startedAt || "") ? 1 : -1
      )
      .slice(0, count);
  }

  async cancelActiveTask(chatId) {
    const chat = await this.getChatState(chatId);
    if (!chat.activeTaskId) return null;
    const taskId = chat.activeTaskId;
    await this.setTaskState(chatId, taskId, {
      status: "cancelled",
      timestamps: { cancelledAt: new Date().toISOString() }
    });
    return taskId;
  }

  // ─── Task queue (for task-generator loop) ───

  async getTaskQueue(chatId) {
    const chat = await this.getChatState(chatId);
    const queue = chat.taskQueue || [];
    return {
      all: queue,
      pending: queue.filter((t) => t.status === "pending"),
      completed: queue.filter((t) => t.status === "completed"),
      failed: queue.filter((t) => t.status === "failed")
    };
  }

  async addToTaskQueue(chatId, item) {
    return this.upsertChatState(chatId, (chat) => {
      const queue = [...(chat.taskQueue || []), item];
      return { ...chat, taskQueue: queue };
    });
  }

  async updateTaskQueueItem(chatId, taskId, patch) {
    return this.upsertChatState(chatId, (chat) => {
      const queue = (chat.taskQueue || []).map((item) => {
        if (item.taskId === taskId) return { ...item, ...patch };
        return item;
      });
      return { ...chat, taskQueue: queue };
    });
  }

  async clearTaskQueue(chatId) {
    return this.upsertChatState(chatId, (chat) => {
      return { ...chat, taskQueue: [] };
    });
  }

  async clearStalePending(chatId) {
    return this.upsertChatState(chatId, (chat) => {
      const queue = (chat.taskQueue || []).filter((t) => t.status !== "pending");
      return { ...chat, taskQueue: queue };
    });
  }
}
