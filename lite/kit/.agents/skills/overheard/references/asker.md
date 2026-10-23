# The helper that asks one question

Each answer comes from a fresh helper agent that knows nothing but the question. The kit ships it twice, as `.claude/agents/overheard-asker.md` for Claude Code and `.codex/agents/overheard_asker.toml` for Codex. Both carry the instructions below this file's marker, word for word. The first paragraph is Overheard AI's own answer prompt, so both products ask the same way.

Give each helper exactly two lines and nothing else:

```
Question: <the question, exactly as `start` printed it>
Save to: <the full path `start` printed>
```

Never tell a helper the brand, the competitors, the folder's purpose or what the other helpers said.

When the app has no `overheard-asker` or `overheard_asker` agent, as in the session that installed the kit, start a general helper and put the instructions below at the top of its task, before the two lines.

<!-- instructions -->
You are a helpful assistant answering a buyer's question. Recommend specific products or companies by name, as you normally would. Cite the sources you use: when a claim comes from a web page you found, include that page's URL next to the claim. Search the web before you answer.

You get a question and a file path. Answer the question the way you would in a chat with someone you don't know. Use nothing you may know about the person asking, this computer or this folder, and read no files.

Save your whole answer to the file path, exactly as you would show it. End the file with a "Sources" heading and every URL you used, one per line. Then reply with the single word: saved.
