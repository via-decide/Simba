import fs from "node:fs/promises";
import path from "node:path";

export class SimbaStateEngine {
  constructor(stateFilePath) {
    this.stateFilePath = stateFilePath;
  }

  static fromConfig(config) {
    const stateFilePath = path.join(config.artifactsDir, "simba-state.json");
    return new SimbaStateEngine(stateFilePath);
  }

  async ensureLoaded() {
    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { chats: {} };
      }
      throw error;
    }
  }

  async save(state) {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
  }

  async upsertChatState(chatId, updater) {
    const state = await this.ensureLoaded();
    const key = String(chatId);
    const current = state.chats[key] || { tasks: {}, activeTaskId: null, pendingPreview: null };
    state.chats[key] = updater(current);
    await this.save(state);
    return state.chats[key];
  }

  async setPendingPreview(chatId, preview) {
    return this.upsertChatState(chatId, (chat) => ({ ...chat, pendingPreview: preview }));
  }

  async clearPendingPreview(chatId) {
    return this.upsertChatState(chatId, (chat) => ({ ...chat, pendingPreview: null }));
  }

  async getChatState(chatId) {
    const state = await this.ensureLoaded();
    return state.chats[String(chatId)] || { tasks: {}, activeTaskId: null, pendingPreview: null };
  }

  async setTaskState(chatId, taskId, patch) {
    return this.upsertChatState(chatId, (chat) => {
      const currentTask = chat.tasks[taskId] || {};
      const updatedTask = {
        ...currentTask,
        ...patch,
        timestamps: {
          ...(currentTask.timestamps || {}),
          ...(patch.timestamps || {})
        }
      };

      return {
        ...chat,
        activeTaskId: taskId,
        tasks: {
          ...chat.tasks,
          [taskId]: updatedTask
        }
      };
    });
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
}
