@AGENTS.md

# Project Overview

IP Portal is a centralized network infrastructure management platform designed for equipment inventory, performance tracking, and topology visualization. It includes a project tracking module inspired by Asana to manage workflows efficiently. The portal features a robust Authentication and Authorization system for secure access control, and it integrates directly with the Cacti Monitoring System via API to retrieve real-time network data.


# Project Overview
Web Portal : Monitor Agent/Sub-agents that can support multi LLM (CODEX, CLAUDE, AGY)
Main Feature:
- Topology for Monitor Main Agent and spawn subagents like tree-force/Fan Out that can show relation ship between Main Agent as parent, spwaned agent as child.
- Show all detial of each agents
- Support multi-Spwan Layer of Subagents
- Support to show topology cross LLM. Example Claude call CODEX as subagent via bash , topology will show claude as parent and codex as child of its.
- Token Size, Cost and Limit (Hours and Weeks)

# Tech-Stack
| Layer      | Technology                                               |
| ---------- | -------------------------------------------------------- |
| Frontend   | TypeScript                                               |
| Backend    | Next.js Server                                           |

