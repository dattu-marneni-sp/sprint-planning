# Sprint Planning Assistant

An automated sprint planning tool that connects to Jira and Confluence to generate a fully planned sprint with task prioritization, team velocity analysis, capacity assessment, and optional execution to assign tickets directly in Jira.

## Use Case

**Trigger:** `"help me plan this sprint"`

**Steps:**
1. Fetch current project status, commitments from Jira and Confluence pages
2. Analyze team velocity and capacity
3. Suggest task prioritization
4. (Optional) Execute: assign tickets, transition statuses, create new tickets

**Result:** Fully planned sprint with tasks organized, assigned, and created in Jira

## Boards Covered

| Project | Board | URL |
|---------|-------|-----|
| DATAG | 2525 | https://sailpoint.atlassian.net/jira/software/c/projects/DATAG/boards/2525 |
| SAASD8NG | 1082 | https://sailpoint.atlassian.net/jira/software/c/projects/SAASD8NG/boards/1082 |
| SAASFD | 2565 | https://sailpoint.atlassian.net/jira/software/c/projects/SAASFD/boards/2565 |

## Architecture

```
plan-sprint.mjs              # Main CLI entry point
lib/
  mcp-client.mjs             # Atlassian MCP connection manager
  jira-fetcher.mjs           # Jira data retrieval (sprints, tickets, velocity)
  confluence-fetcher.mjs     # Confluence commitments & availability
  velocity-analyzer.mjs      # Velocity calculation & capacity assessment
  sprint-planner.mjs         # Task scoring, prioritization & plan generation
  sprint-executor.mjs        # Execute plan: assign, transition, create tickets
```

## Running

### Prerequisites
- Node.js v18+ (installed at `~/.local/node-v22.13.1-darwin-arm64/bin`)
- Atlassian MCP access (via `mcp-remote`)
- Authenticated Atlassian session

### Plan Only (Read-Only)

```bash
node plan-sprint.mjs
```

Generates `sprint-plan.md` without modifying anything in Jira.

### Dry Run (Preview Execution)

```bash
node plan-sprint.mjs --dry-run
```

Shows exactly what would happen if you execute, without making any changes.

### Execute (Assign Tickets)

```bash
node plan-sprint.mjs --execute
```

Generates the plan and then assigns tickets to team members in Jira. Prompts for confirmation before making changes.

### Execute with All Options

```bash
node plan-sprint.mjs --execute --create --transition -y
```

| Flag | Description |
|------|-------------|
| `--execute` | Enable execution mode (assigns tickets) |
| `--dry-run` | Preview execution without changes |
| `--create` | Create new Jira tickets for unassigned items |
| `--transition` | Transition Backlog tickets to "To Do" |
| `-y`, `--yes` | Skip confirmation prompt |
| `-h`, `--help` | Show usage help |

## What the Planner Does

### Phase 1: Data Collection
- Fetches **active sprint tickets** from all 3 boards
- Retrieves **backlog items** for potential sprint inclusion
- Identifies **carry-over items** from previous sprint
- Discovers **team members** and their current assignments
- Pulls **historical sprint data** (last 3 sprints) for velocity
- Reads **Confluence pages** for team commitments and priorities
- Checks for **OOO / availability** information

### Phase 2: Velocity & Capacity Analysis
- Calculates **average tickets per sprint** per project
- Determines **velocity trend** (improving / stable / declining)
- Assesses **team capacity** based on available members
- Factors in **OOO** to reduce planned capacity

### Phase 3: Task Prioritization
Tickets are scored using a multi-factor algorithm:

| Factor | Weight | Description |
|--------|--------|-------------|
| Priority | 1-5 pts | Jira priority (Highest=5, Lowest=1) |
| Status | 0.5-3 pts | In-progress items score highest |
| Carry-over | +3 pts | Rolling items from previous sprint |
| Commitment match | +2 pts | Aligns with Confluence commitments |
| Bug type | +1.5 pts | Bugs get automatic priority boost |
| Story points | 0-2 pts | Larger items get attention factor |

### Phase 4: Sprint Plan Output
Produces a comprehensive markdown plan including:
- Sprint goal and date range
- Executive summary table
- Team velocity trends
- Team capacity breakdown
- Carry-over, committed, and new work sections
- Per-member assignments with point totals
- Stretch goals
- Risks and notes

### Phase 5: Execution (Optional)
When `--execute` or `--dry-run` is used:
- **Assign tickets** to team members via Jira API
- **Transition statuses** from Backlog to "To Do" (with `--transition`)
- **Create new tickets** for planned items (with `--create`)
- Generates an `execution-report.md` with results

## Output Files

| File | Description |
|------|-------------|
| `sprint-plan.md` | Generated sprint plan (always created) |
| `execution-report.md` | Execution results (only with --execute/--dry-run) |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NPX_PATH` | Path to npx binary | `~/.local/node-v22.13.1-darwin-arm64/bin/npx` |

## License

Internal use - SailPoint
