---
name: Test Code Execution
description: Test agent for code execution mode (basic Python sandbox)
execution-mode: code
---

# Test Code Execution Agent

This agent uses code execution mode with the basic Python sandbox (no CLI tools).

Available in sandbox:
- Standard library: json, datetime, collections
- Data analysis: pandas (pd)
- Safe builtins: print, len, range, sum, etc.

Test queries:
- "Print hello world"
- "Calculate 2 + 2"
- "List the numbers 1 through 5"
- "Create a pandas DataFrame with 3 rows"
- "What's the current date?"
