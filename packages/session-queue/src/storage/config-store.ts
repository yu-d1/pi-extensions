import * as fs from "node:fs";
import type { Config, Logger } from "../types";
import { atomicWriteFile } from "../utils/fs";
import { normalizeWorkspace } from "../utils/path";
import { CONFIG_VERSION, DEFAULT_KEEP_QUEUE } from "../constants";

export class ConfigStore {
  private cache: Config | null = null;

  constructor(
    readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  load(): Config {
    if (this.cache) return this.clone(this.cache);

    let cfg: Config;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      cfg = this.normalize(JSON.parse(raw) as Partial<Config>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cfg = this.defaults();
      } else {
        this.logger.warn("config.json 读取失败，使用默认配置", err);
        cfg = this.defaults();
      }
    }

    this.cache = cfg;
    return this.clone(cfg);
  }

  save(config: Config): void {
    const normalized = this.normalize(config);
    atomicWriteFile(this.filePath, JSON.stringify(normalized, null, 2));
    this.cache = normalized;
  }

  update(mutator: (config: Config) => void): Config {
    const next = this.clone(this.load());
    mutator(next);
    this.save(next);
    return this.clone(next);
  }

  invalidate(): void {
    this.cache = null;
  }

  private defaults(): Config {
    return {
      version: CONFIG_VERSION,
      workspaces: [],
      followSessionTree: true,
      keepQueueCountPerWorkspace: DEFAULT_KEEP_QUEUE,
      clearDataOnRemoveWorkspace: true,
    };
  }

  private normalize(input: Partial<Config>): Config {
    const workspaces = Array.isArray(input.workspaces)
      ? input.workspaces
          .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
          .map((w) => normalizeWorkspace(w))
      : [];

    // 去重（Windows 忽略大小写）。
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const ws of workspaces) {
      const key = process.platform === "win32" ? ws.toLowerCase() : ws;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(ws);
    }

    const keep = typeof input.keepQueueCountPerWorkspace === "number"
      && Number.isFinite(input.keepQueueCountPerWorkspace)
      && input.keepQueueCountPerWorkspace > 0
      ? Math.floor(input.keepQueueCountPerWorkspace)
      : DEFAULT_KEEP_QUEUE;

    return {
      version: CONFIG_VERSION,
      workspaces: unique,
      followSessionTree: typeof input.followSessionTree === "boolean" ? input.followSessionTree : true,
      keepQueueCountPerWorkspace: keep,
      clearDataOnRemoveWorkspace:
        typeof input.clearDataOnRemoveWorkspace === "boolean" ? input.clearDataOnRemoveWorkspace : true,
    };
  }

  private clone(config: Config): Config {
    return {
      ...config,
      workspaces: [...config.workspaces],
    };
  }
}
