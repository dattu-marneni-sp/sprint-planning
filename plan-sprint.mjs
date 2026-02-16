#!/usr/bin/env node
/**
 * Sprint Planning CLI
 *
 * Usage:
 *   node plan-sprint.mjs                     # Generate plan only (read-only)
 *   node plan-sprint.mjs --execute           # Generate plan + execute assignments
 *   node plan-sprint.mjs --dry-run           # Generate plan + show what would be executed
 *   node plan-sprint.mjs --execute --create  # Also create new tickets
 *   node plan-sprint.mjs --execute --transition  # Also transition Backlog → To Do
 *
 * Trigger: "help me plan this sprint"
 *
 * Steps:
 *   1. Fetch current project status, commitments from Jira and Confluence
 *   2. Analyze team velocity and capacity
 *   3. Suggest task prioritization
 *   4. (Optional) Execute: assign tickets, transition statuses, create new tickets
 *   Result: Fully planned sprint with tasks created
 *
 * Boards covered:
 *   - DATAG  (board 2525)
 *   - SAASD8NG (board 1082)
 *   - SAASFD (board 2565)
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { MCPClient } from './lib/mcp-client.mjs';
import { JiraFetcher } from './lib/jira-fetcher.mjs';
import { ConfluenceFetcher } from './lib/confluence-fetcher.mjs';
import { VelocityAnalyzer } from './lib/velocity-analyzer.mjs';
import { SprintPlanner } from './lib/sprint-planner.mjs';
import { SprintExecutor } from './lib/sprint-executor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = __dirname;
const PLAN_FILE = join(OUTPUT_DIR, 'sprint-plan.md');
const EXEC_REPORT_FILE = join(OUTPUT_DIR, 'execution-report.md');

// Parse CLI args
const args = process.argv.slice(2);
const FLAGS = {
  execute: args.includes('--execute'),
  dryRun: args.includes('--dry-run'),
  create: args.includes('--create'),
  transition: args.includes('--transition'),
  skipConfirm: args.includes('--yes') || args.includes('-y'),
  help: args.includes('--help') || args.includes('-h')
};

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function logPhase(phase, msg) {
  const bar = '='.repeat(60);
  log('');
  log(bar);
  log(`  PHASE ${phase}: ${msg}`);
  log(bar);
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

function printUsage() {
  log('');
  log('  Sprint Planning Assistant v2.0');
  log('');
  log('  Usage:');
  log('    node plan-sprint.mjs                          Generate plan only (read-only)');
  log('    node plan-sprint.mjs --execute                Generate plan + execute assignments');
  log('    node plan-sprint.mjs --dry-run                Show what would be executed (no changes)');
  log('    node plan-sprint.mjs --execute --create       Also create new tickets in Jira');
  log('    node plan-sprint.mjs --execute --transition   Also transition Backlog tickets to To Do');
  log('    node plan-sprint.mjs --execute --create --transition -y   Execute all with no confirmation');
  log('');
  log('  Flags:');
  log('    --execute       Execute the plan (assign tickets to members)');
  log('    --dry-run       Preview execution without making changes');
  log('    --create        Create new Jira tickets for unassigned items');
  log('    --transition    Transition Backlog tickets to To Do');
  log('    -y, --yes       Skip confirmation prompt');
  log('    -h, --help      Show this help');
  log('');
}

async function main() {
  if (FLAGS.help) {
    printUsage();
    return;
  }

  const startTime = Date.now();
  const willExecute = FLAGS.execute || FLAGS.dryRun;

  log('');
  log('  ============================================');
  log('  |      SPRINT PLANNING ASSISTANT v2.0      |');
  log('  |   "help me plan this sprint"             |');
  log('  ============================================');
  if (willExecute) {
    log(`  Mode: ${FLAGS.dryRun ? 'DRY RUN (preview only)' : 'EXECUTE (will modify Jira)'}`);
    if (FLAGS.create) log('  + Create new tickets');
    if (FLAGS.transition) log('  + Transition Backlog → To Do');
  } else {
    log('  Mode: PLAN ONLY (read-only)');
  }
  log('');

  // ── PHASE 0: Connect to Atlassian ──
  logPhase(0, 'Connecting to Atlassian MCP');
  const mcp = new MCPClient();
  await mcp.connect();
  log('  Connected to Atlassian MCP.');

  const jira = await JiraFetcher.create(mcp);
  const cloudId = jira.cloudId;
  const confluence = new ConfluenceFetcher(mcp, cloudId);
  log(`  Cloud ID: ${cloudId}`);

  try {
    // ── PHASE 1: Fetch Current Project Status ──
    logPhase(1, 'Fetching Current Project Status from Jira & Confluence');

    log('\n[1a] Active sprint tickets...');
    const activeTickets = await jira.fetchActiveSprintTickets();

    log('\n[1b] Backlog items...');
    const backlog = await jira.fetchBacklog();

    log('\n[1c] Carry-over items...');
    const carryOver = await jira.fetchCarryOver();

    log('\n[1d] Team members...');
    const teamMembers = await jira.fetchTeamMembers();
    log(`  Found ${teamMembers.length} team members`);

    log('\n[1e] Completed sprints (velocity data)...');
    const completedSprints = await jira.fetchCompletedSprintData(3);

    log('\n[1f] Confluence commitments...');
    const commitmentPages = await confluence.fetchTeamCommitments();

    log('\n[1g] Team availability (OOO)...');
    const availabilityInfo = await confluence.fetchAvailabilityInfo();

    // Enrich active sprint tickets with assignee data from getJiraIssue
    log('\n[1h] Enriching ticket details (fetching assignees)...');

    const allActiveBase = [];
    for (const [project, tickets] of Object.entries(activeTickets)) {
      for (const t of tickets.slice(0, 30)) {
        allActiveBase.push({ ...t, project });
      }
    }
    const allBacklogBase = [];
    for (const [project, tickets] of Object.entries(backlog)) {
      for (const t of tickets.slice(0, 15)) {
        allBacklogBase.push({ ...t, project });
      }
    }

    const activeKeys = allActiveBase.map(t => t.key).slice(0, 50);
    const backlogKeys = allBacklogBase.map(t => t.key).slice(0, 30);

    const detailedActive = await jira.fetchTicketDetails(activeKeys, allActiveBase);
    const detailedBacklog = await jira.fetchTicketDetails(backlogKeys, allBacklogBase);

    log(`  Enriched ${detailedActive.length} active + ${detailedBacklog.length} backlog tickets`);
    const withAssignee = detailedActive.filter(t => t.assignee && t.assignee !== 'Unassigned');
    log(`  Tickets with assignees: ${withAssignee.length}`);

    // ── PHASE 2: Analyze Velocity & Capacity ──
    logPhase(2, 'Analyzing Team Velocity & Capacity');

    const analyzer = new VelocityAnalyzer();

    log('\n[2a] Calculating velocity...');
    const velocity = analyzer.calculateVelocity(completedSprints);
    for (const [project, v] of Object.entries(velocity)) {
      log(`  ${project}: ${v.avgTicketsPerSprint} tickets/sprint (${v.trend})`);
    }

    log('\n[2b] Assessing capacity...');
    const capacity = analyzer.assessCapacity(teamMembers, availabilityInfo);
    log(`  Total capacity: ${capacity.totalCapacity} points`);
    log(`  Available: ${capacity.totalMembers - capacity.oooMembers.length}/${capacity.totalMembers} members`);
    if (capacity.oooMembers.length > 0) {
      log(`  OOO: ${capacity.oooMembers.join(', ')}`);
    }

    log('\n[2c] Generating capacity summary...');
    const capacitySummary = analyzer.generateCapacitySummary(velocity, capacity);
    log(`  Recommendation: ${capacitySummary.recommendation}`);

    // ── PHASE 3: Prioritize Tasks & Generate Sprint Plan ──
    logPhase(3, 'Prioritizing Tasks & Generating Sprint Plan');

    const planner = new SprintPlanner();

    const allTickets = [...detailedActive, ...detailedBacklog].filter(t => t.key);

    const allCarryOver = [];
    for (const [_, tickets] of Object.entries(carryOver)) {
      allCarryOver.push(...tickets);
    }

    const allCommitments = [];
    for (const page of commitmentPages) {
      if (page.content) {
        allCommitments.push(...confluence.parseCommitmentsText(page.content));
      }
    }
    log(`  Found ${allCommitments.length} commitments from Confluence`);

    log('\n[3a] Scoring and ranking tickets...');
    const scoredTickets = planner.scoreTickets(allTickets, allCarryOver, allCommitments);
    log(`  Scored ${scoredTickets.length} tickets`);

    log('\n[3b] Generating sprint plan...');
    const plan = planner.generateSprintPlan(scoredTickets, capacity, velocity);
    log(`  Sprint goal: ${plan.sprintGoal}`);
    log(`  Planned: ${plan.totalTickets} tickets, ${plan.totalPoints} points`);

    log('\n[3c] Formatting plan...');
    const markdown = planner.formatPlanAsMarkdown(plan, velocity, capacity);

    // ── PHASE 4: Save Plan ──
    logPhase(4, 'Saving Sprint Plan');
    writeFileSync(PLAN_FILE, markdown, 'utf-8');
    log(`  Sprint plan saved to: ${PLAN_FILE}`);
    process.stdout.write(markdown);

    // ── PHASE 5: Execute Sprint Plan (if requested) ──
    if (willExecute) {
      logPhase(5, FLAGS.dryRun ? 'Dry Run Preview' : 'Executing Sprint Plan');

      // Show what will happen
      const assignCount = Object.values(plan.assignments).reduce((s, a) => s + a.tickets.length, 0);
      log(`\n  Actions to ${FLAGS.dryRun ? 'preview' : 'execute'}:`);
      log(`    - Assign ${assignCount} tickets to ${Object.keys(plan.assignments).length} team members`);
      if (FLAGS.transition) {
        const backlogTickets = [...plan.sections.carryOver, ...plan.sections.newWork]
          .filter(t => t.status && t.status.toLowerCase() === 'backlog');
        log(`    - Transition ${backlogTickets.length} tickets from Backlog → To Do`);
      }
      if (FLAGS.create) {
        const toCreate = (plan.unassigned || []).filter(t => !t.key);
        log(`    - Create ${toCreate.length} new tickets`);
      }
      log('');

      // Confirm unless --yes or --dry-run
      let proceed = FLAGS.dryRun || FLAGS.skipConfirm;
      if (!proceed) {
        proceed = await askConfirmation('  Proceed with execution? (y/N): ');
      }

      if (proceed) {
        const executor = new SprintExecutor(mcp, cloudId);
        const results = await executor.execute(plan, {
          assign: true,
          createNew: FLAGS.create,
          transition: FLAGS.transition,
          dryRun: FLAGS.dryRun
        });

        // Save execution report
        const execReport = executor.generateReport();
        writeFileSync(EXEC_REPORT_FILE, execReport, 'utf-8');
        log(`  Execution report saved to: ${EXEC_REPORT_FILE}`);
      } else {
        log('  Execution cancelled by user.');
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('');
    log('  ============================================');
    log(`  |  SPRINT PLANNING COMPLETE (${elapsed}s)        |`);
    log('  ============================================');
    log('');

  } catch (err) {
    log(`\nError: ${err.message}`);
    log(err.stack);
    process.exit(1);
  } finally {
    mcp.disconnect();
  }
}

main();
