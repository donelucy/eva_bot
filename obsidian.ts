import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Tool, ToolContext } from "../types.js";
import { logger } from "../utils/logger.js";

const VAULT_DIR = join(homedir(), ".mybot", "obsidian-vault");

/**
 * Obsidian-compatible memory system using Markdown files
 * Can be opened directly in Obsidian app
 */
export class ObsidianMemory {
  private vaultPath: string;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath ?? VAULT_DIR;
    this.ensureVault();
  }

  private ensureVault(): void {
    if (!existsSync(this.vaultPath)) {
      mkdirSync(this.vaultPath, { recursive: true });
      logger.info(`[Obsidian] Created vault at ${this.vaultPath}`);
    }

    // Create default folders
    const folders = ["People", "Topics", "Daily", "Preferences"];
    for (const folder of folders) {
      const folderPath = join(this.vaultPath, folder);
      if (!existsSync(folderPath)) {
        mkdirSync(folderPath, { recursive: true });
      }
    }

    // Create .obsidian config if doesn't exist (makes it a valid Obsidian vault)
    const obsidianConfig = join(this.vaultPath, ".obsidian");
    if (!existsSync(obsidianConfig)) {
      mkdirSync(obsidianConfig, { recursive: true });
      writeFileSync(
        join(obsidianConfig, "workspace.json"),
        JSON.stringify({ main: { children: [] } }, null, 2)
      );
    }
  }

  /**
   * Save a note (memory) to the vault
   */
  saveNote(title: string, content: string, folder = ""): string {
    const sanitized = title.replace(/[/\\?%*:|"<>]/g, "-");
    const filePath = join(this.vaultPath, folder, `${sanitized}.md`);
    
    const timestamp = new Date().toISOString().split("T")[0];
    const frontmatter = `---
created: ${timestamp}
updated: ${timestamp}
---

`;

    writeFileSync(filePath, frontmatter + content);
    logger.info(`[Obsidian] Saved note: ${title}`);
    return filePath;
  }

  /**
   * Append to an existing note or create if doesn't exist
   */
  appendNote(title: string, content: string, folder = ""): string {
    const sanitized = title.replace(/[/\\?%*:|"<>]/g, "-");
    const filePath = join(this.vaultPath, folder, `${sanitized}.md`);

    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf-8");
      const updated = existing.replace(
        /updated: \d{4}-\d{2}-\d{2}/,
        `updated: ${new Date().toISOString().split("T")[0]}`
      );
      writeFileSync(filePath, updated + "\n\n" + content);
    } else {
      this.saveNote(title, content, folder);
    }

    return filePath;
  }

  /**
   * Read a note from the vault
   */
  readNote(title: string, folder = ""): string | null {
    const sanitized = title.replace(/[/\\?%*:|"<>]/g, "-");
    const filePath = join(this.vaultPath, folder, `${sanitized}.md`);

    if (!existsSync(filePath)) {
      return null;
    }

    return readFileSync(filePath, "utf-8");
  }

  /**
   * Search notes by keyword (simple grep)
   */
  searchNotes(query: string): Array<{ file: string; matches: string[] }> {
    const results: Array<{ file: string; matches: string[] }> = [];
    const searchDir = (dir: string) => {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(dir, item.name);
        if (item.isDirectory() && !item.name.startsWith(".")) {
          searchDir(fullPath);
        } else if (item.isFile() && item.name.endsWith(".md")) {
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          const matches = lines.filter((line) =>
            line.toLowerCase().includes(query.toLowerCase())
          );
          if (matches.length > 0) {
            results.push({
              file: fullPath.replace(this.vaultPath, "").slice(1),
              matches: matches.slice(0, 3), // First 3 matches
            });
          }
        }
      }
    };

    searchDir(this.vaultPath);
    return results;
  }

  /**
   * List all notes in vault
   */
  listNotes(folder = ""): string[] {
    const targetPath = folder ? join(this.vaultPath, folder) : this.vaultPath;
    if (!existsSync(targetPath)) return [];

    const files: string[] = [];
    const scanDir = (dir: string) => {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(dir, item.name);
        if (item.isDirectory() && !item.name.startsWith(".")) {
          scanDir(fullPath);
        } else if (item.isFile() && item.name.endsWith(".md")) {
          files.push(fullPath.replace(this.vaultPath, "").slice(1));
        }
      }
    };

    scanDir(targetPath);
    return files;
  }

  getVaultPath(): string {
    return this.vaultPath;
  }
}

/**
 * Build Obsidian-compatible memory tools
 */
export function makeObsidianTools(): Tool[] {
  const obsidian = new ObsidianMemory();

  const saveNoteTool: Tool = {
    name: "obsidian_save",
    description: "Save a note to Obsidian vault. Use for important information, facts, preferences, etc. Supports Markdown and [[wikilinks]].",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title (e.g., 'User Preferences', 'Python Tips')" },
        content: { type: "string", description: "Note content in Markdown. Use [[links]] to reference other notes." },
        folder: { type: "string", description: "Optional folder: People, Topics, Daily, or Preferences (default: root)" },
      },
      required: ["title", "content"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const title = args["title"] as string;
      const content = args["content"] as string;
      const folder = (args["folder"] as string) ?? "";

      const filePath = obsidian.saveNote(title, content, folder);
      return `✅ Note saved: ${title}\nLocation: ${filePath}`;
    },
  };

  const appendNoteTool: Tool = {
    name: "obsidian_append",
    description: "Append content to an existing note (or create if doesn't exist). Use to add to existing knowledge.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title to append to" },
        content: { type: "string", description: "Content to append" },
        folder: { type: "string", description: "Optional folder" },
      },
      required: ["title", "content"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const title = args["title"] as string;
      const content = args["content"] as string;
      const folder = (args["folder"] as string) ?? "";

      obsidian.appendNote(title, content, folder);
      return `✅ Appended to note: ${title}`;
    },
  };

  const readNoteTool: Tool = {
    name: "obsidian_read",
    description: "Read a note from the Obsidian vault by title.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title to read" },
        folder: { type: "string", description: "Optional folder" },
      },
      required: ["title"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const title = args["title"] as string;
      const folder = (args["folder"] as string) ?? "";

      const content = obsidian.readNote(title, folder);
      if (!content) {
        return `❌ Note not found: ${title}`;
      }

      return content;
    },
  };

  const searchNotesTool: Tool = {
    name: "obsidian_search",
    description: "Search all notes for a keyword or phrase.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const query = args["query"] as string;
      const results = obsidian.searchNotes(query);

      if (results.length === 0) {
        return `No results found for: ${query}`;
      }

      const formatted = results
        .slice(0, 10)
        .map((r) => {
          const matches = r.matches.map((m) => `  > ${m}`).join("\n");
          return `📄 **${r.file}**\n${matches}`;
        })
        .join("\n\n");

      return `Found ${results.length} notes:\n\n${formatted}`;
    },
  };

  const listNotesTool: Tool = {
    name: "obsidian_list",
    description: "List all notes in the vault or a specific folder.",
    parameters: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Optional folder (People, Topics, Daily, Preferences)" },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const folder = (args["folder"] as string) ?? "";
      const notes = obsidian.listNotes(folder);

      if (notes.length === 0) {
        return "No notes found.";
      }

      const organized: Record<string, string[]> = {};
      for (const note of notes) {
        const folder = note.includes("/") ? note.split("/")[0] : "Root";
        if (!organized[folder]) organized[folder] = [];
        organized[folder]!.push(note);
      }

      const formatted = Object.entries(organized)
        .map(([folder, files]) => {
          const fileList = files.map((f) => `  • ${f}`).join("\n");
          return `**${folder}/**\n${fileList}`;
        })
        .join("\n\n");

      return `📚 **Obsidian Vault** (${notes.length} notes)\n\n${formatted}\n\nVault location: ${obsidian.getVaultPath()}`;
    },
  };

  return [saveNoteTool, appendNoteTool, readNoteTool, searchNotesTool, listNotesTool];
}
