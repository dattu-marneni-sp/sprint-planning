# Sprint Planning Assistant

An automated sprint planning tool that connects to Jira and Confluence to generate a fully planned sprint with task prioritization, team velocity analysis, and capacity assessment.

## Use Case

**Trigger:** `"help me plan this sprint"`

**Steps:**
1. Fetch current project status, commitments from Jira and Confluence pages
2. Analyze team velocity and capacity
3. Suggest task prioritization

**Result:** Fully planned sprint with tasks organized by priority

## Boards Covered

| Project | Board | URL |
|---------|-------|-----|
| DATAG | 2525 | https://sailpoint.atlassian.net/jira/software/c/projects/DATAG/boards/2525 |
| SAASD8NG | 1082 | https://sailpoint.atlassian.net/jira/software/c/projects/SAASD8NG/boards/1082 |
| SAASFD | 2565 | https://sailpoint.atlassian.net/jira/software/c/projects/SAASFD/boards/2565 |

## Architecture

```
plan-sprint.mjs          # Main CLI entry point
lib/
  mcp-client.mjs         # Atlassian MCP connection manager
  jira-fetcher.mjs       # Jira data retrieval (sprints, tickets, velocity)
  confluence-fetcher.mjs  # Confluence commitments & availability
  velocity-analyzer.mjs   # Velocity calculation & capacity assessment
  sprint-planner.mjs      # Task scoring, prioritization & plan generation
```

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

### Phase 4: Sprint Plan Generation
Produces a comprehensive markdown plan including:
- Sprint goal and date range
- Executive summary table
- Team velocity trends
- Team capacity breakdown
- Carry-over, committed, and new work sections
- Per-member assignments with point totals
- Stretch goals
- Risks and notes

## Running

### Prerequisites
- Node.js v18+ (installed at `~/.local/node-v22.13.1-darwin-arm64/bin`)
- Atlassian MCP access (via `mcp-remote`)
- Authenticated Atlassian session

### Run Sprint Planning

```bash
node plan-sprint.mjs
```

The sprint plan will be:
- Printed to stdout
- Saved to `sprint-plan.md` in the project directory

### Output Example

The generated `sprint-plan.md` includes:
- Sprint dates and goals
- Velocity analysis per project
- Capacity assessment per team member
- Prioritized ticket list with scores
- Sprint assignments per person
- Stretch goals and overflow items
- Risk assessment

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NPX_PATH` | Path to npx binary | `~/.local/node-v22.13.1-darwin-arm64/bin/npx` |

## License

Internal use - SailPoint
