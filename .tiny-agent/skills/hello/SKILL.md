---
name: hello
# Keep the trigger concrete so it is easy to test progressive loading.
description: Greets the user and reports the current project name. Use when the user asks to say hello, greet them, or test skill loading.
---

# Hello Skill

When this skill is used:

1. Read `package.json` with the `read` tool.
2. Find the project `name`.
3. Reply with exactly this structure:

```text
Hello from <project-name>! Skill loaded successfully.
```

Do not modify any files.
