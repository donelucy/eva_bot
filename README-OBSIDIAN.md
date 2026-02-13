# 🧠 Obsidian Memory Integration

MyBot now includes an **Obsidian-compatible memory system** that stores knowledge as Markdown files in a vault.

## Features

✅ **Markdown-based** - All memories are readable `.md` files
✅ **Wikilinks** - Use `[[Note Name]]` to link notes together
✅ **Organized folders** - People, Topics, Daily, Preferences
✅ **Open in Obsidian** - View/edit the vault in Obsidian app
✅ **Full-text search** - Search across all notes
✅ **Append support** - Add to existing notes over time
✅ **Frontmatter** - Tracks created/updated dates

## Tools Available

### `obsidian_save`
Save a new note to the vault.

```
obsidian_save(
  title="Python Tips",
  content="## List Comprehensions\n\n[a*2 for a in range(10)]\n\nSee also: [[Python Basics]]",
  folder="Topics"  // optional: People, Topics, Daily, Preferences
)
```

### `obsidian_append`
Add content to an existing note (or create if doesn't exist).

```
obsidian_append(
  title="Daily Log",
  content="## 2026-02-13\n\nLearned about decorators today."
)
```

### `obsidian_read`
Read a note from the vault.

```
obsidian_read(title="Python Tips", folder="Topics")
```

### `obsidian_search`
Search all notes for keywords.

```
obsidian_search(query="decorators")
```

### `obsidian_list`
List all notes in vault or specific folder.

```
obsidian_list()  // all notes
obsidian_list(folder="People")  // just People folder
```

## Usage Examples

**User:** "Remember that I prefer TypeScript over JavaScript"
**Bot uses:** `obsidian_save(title="User Preferences", content="## Programming\n- Prefers TypeScript over JavaScript", folder="Preferences")`

**User:** "Tell me about that conversation we had about Python"
**Bot uses:** `obsidian_search(query="Python")` → finds relevant notes

**User:** "Add that I learned about async/await today"
**Bot uses:** `obsidian_append(title="Daily Log", content="## 2026-02-13\n- Learned async/await in Python")`

## Vault Location

Default: `~/.mybot/obsidian-vault/`
- Windows: `C:\Users\YourName\.mybot\obsidian-vault\`
- Linux/Mac: `/home/username/.mybot/obsidian-vault/`

## Opening in Obsidian

1. Download Obsidian from https://obsidian.md
2. Open Obsidian → "Open folder as vault"
3. Navigate to `~/.mybot/obsidian-vault/`
4. View your bot's knowledge graph! 🎉

## Folder Structure

```
obsidian-vault/
├── .obsidian/           # Obsidian settings
├── People/              # Notes about people
├── Topics/              # Topic-specific notes
├── Daily/               # Daily logs, journals
├── Preferences/         # User preferences
└── [root notes]         # General notes
```

## Tips

- Use `[[wikilinks]]` to connect related notes
- Bot will automatically create folders
- All notes include frontmatter with dates
- Search is case-insensitive
- Vault can be synced with Obsidian Sync or git

## Comparison: Old Memory vs Obsidian

| Feature | Old Memory | Obsidian |
|---------|-----------|----------|
| Format | Key-value pairs | Markdown files |
| Structure | Flat | Organized folders |
| Links | None | Wikilinks |
| Viewing | Database only | Open in Obsidian |
| Search | By key | Full-text search |
| Long content | Limited | Unlimited |

## When to Use What?

**Use old memory** (`memory_remember`) for:
- Simple key-value facts
- Quick preferences
- Single values

**Use Obsidian** for:
- Structured information
- Long-form content
- Related topics (with wikilinks)
- Knowledge that needs organization

Both systems work together! The bot will choose the appropriate one based on context.
